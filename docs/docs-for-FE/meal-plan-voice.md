# Trợ lý giọng nói của meal planner

Người dùng nói chuyện trực tiếp (full duplex) với mô hình giọng nói **GPT-Live 1.1** qua **Vercel AI Gateway**. Phần việc thật (thực đơn, công thức, nhật ký, chỉ số cơ thể) vẫn do **agent planner hiện tại** (Claude Haiku) làm ở API, với cùng tool, moderation, quota và lịch sử thread như chat chữ.

```
Mic ─► experimental_useRealtime ─WS─► AI Gateway ─► GPT-Live 1.1
            │ delegation-created + transcript
            ▼
   POST /meal-plan/voice/turns ─► planner (chế độ voice)
            │ { text, actions }
            ▼
   FE hiện panel theo actions, gửi text lại qua context-append (channel commentary)
```

Cấu hình API: `AI_GATEWAY_API_KEY` (để trống thì `/session` trả 503) và `VOICE_REALTIME_MODEL` (mặc định `openai/gpt-live-1.1`; FE dùng cùng model id).

## POST /meal-plan/voice/session

Cấp token ngắn hạn (`vcst_…`, 60 giây để mở WebSocket; phiên đã mở không bị cắt khi token hết hạn). Cần Bearer token, có rate limit theo user.

```json
{
  "token": "vcst_…",
  "url": "wss://ai-gateway.vercel.sh/v4/ai/live-model?ai-model-id=openai%2Fgpt-live-1.1",
  "expiresAt": 1795541723,
  "model": "openai/gpt-live-1.1"
}
```

`experimental_useRealtime` gọi endpoint token bằng `fetch` không kèm header Authorization, nên FE đặt một route cùng origin (`/api/meal-planner/voice/session`) đọc cookie phiên rồi gọi endpoint này.

Lỗi: `401` chưa đăng nhập, `429 TOO_MANY_REQUESTS` gọi quá nhanh, `429 AI_QUOTA_EXCEEDED` đã dùng hết lượt AI chữ (mỗi lượt nói tính vào quota chat thực đơn, nên không cấp phiên khi không còn lượt; tài khoản admin không bị giới hạn, giống chat chữ), `503 SERVICE_UNAVAILABLE` chưa cấu hình voice.

## POST /meal-plan/voice/turns

Chạy planner ở chế độ voice cho một lượt nói (một delegation của GPT-Live) và **stream** kết quả dưới dạng AI SDK UI message stream (SSE), cùng định dạng với `POST /meal-plan/chat`.

```json
{
  "weekStart": "2026-11-23",
  "message": "trưa nay mình ăn một tô phở chay",
  "threadId": "8a2c…",
  "requestId": "item_9tA2bF3h7K9m2P5q8R1s4",
  "webSearchRequest": { "toolCallId": "call_…", "reason": "Tìm nơi bán tempeh ở Đà Nẵng" }
}
```

- `message`: lời người dùng đã chép từ transcript (`transcript-fragment` của speaker `user` từ sau delegation trước). Tối đa bằng giới hạn tin nhắn chat.
- `threadId`: thread chat để lưu lượt này. FE gửi thread đang mở trong khung chat, rồi tải lại thread đó (`GET /meal-plan/chat/threads/:threadId`) để lượt nói hiện ngay trong khung chat. Bỏ trống thì API tạo thread mới.
- `requestId`: nên dùng delegation id để quota không bị trừ hai lần khi gửi lại.
- `webSearchRequest` (tùy chọn): gửi khi lượt trước kết thúc ở `requestWebSearch` (phần tool ở trạng thái `input-available`). API đọc `message` như câu trả lời bằng lời (đồng ý / từ chối / chưa rõ); đồng ý thì lượt này được tìm web, chưa rõ thì `message` được xử lý như một yêu cầu mới.

Đọc stream bằng `parseJsonEventStream` + `readUIMessageStream` của `ai`. Mỗi phần tool chuyển sang `output-available` là một việc đã xong, FE phản chiếu ngay lên màn hình:

| tool | output | FE làm gì |
| --- | --- | --- |
| `showRecipe` | `{ shown, recipeId, title }` | mở công thức (trên lịch nếu món có trong tuần, không thì mở sheet riêng) |
| `openEatingLog` | `{ opened, date }` | mở nhật ký ở ngày `date` (null = hôm nay) |
| `showBodyMetrics` | `{ shown, heightCm, weightKg, targetWeightKg, bmi, bmiCategory, dailyCalorieTarget }` | mở tab BMI |
| `logMeal` | `{ entry }` (như `POST /meal-plan/log`) | làm mới nhật ký, mở ngày `entry.date` |
| `updateBodyMetrics` | `{ heightCm, weightKg, targetWeightKg, bmi, bmiCategory, dailyCalorieTarget }` | làm mới `/dietary/nutrition`, mở tab BMI |
| `undoLastChange` | `{ messageId, weeks: [{ weekStart, restored, skipped, droppedDishes }] }` | làm mới thực đơn, chuyển tới ngày vừa khôi phục |
| `fillSlots`, `editPlan`, `autoBalancePlan`, `verifyMealPlanAllergies` | như chat chữ | làm mới thực đơn |
| `updatePreferences`, `updateAllergyNote` | như chat chữ | làm mới `/dietary/me` |

Phần `text` của tin nhắn cuối là câu trả lời ngắn để GPT-Live diễn đạt lại: gửi bằng `context-append` với `delegationId` của lượt và `providerOptions.openai.channel = "commentary"` (tối đa 500 token mỗi lần). Lượt chạy lâu (trên 6 giây) có thể gửi thêm một câu `commentary` ngắn cho mỗi thay đổi đã lưu.

`undoLastChange` đưa thực đơn về như trước lần thay đổi gần nhất chưa hoàn tác trong thread, không xóa tin nhắn (nút "Quay lại" của chat vẫn dùng được). Chế độ voice không có `askUser`: khi cần người dùng chọn, planner hỏi bằng lời.

**Hủy:** đóng request (abort) khi người dùng nói tiếp hoặc kết thúc cuộc gọi; agent dừng, những gì đã lưu vẫn giữ. FE báo cho GPT-Live bằng `context-append` kênh `thinking` cho delegation cũ.

Lỗi (trước khi stream bắt đầu, dạng JSON như mọi endpoint): `429 AI_QUOTA_EXCEEDED` hết lượt AI, `429` gọi quá nhanh, `503` moderation hoặc model lỗi, `404` thread không thuộc người dùng. Lỗi giữa stream đến dưới dạng phần `error`. Khi lỗi, FE vẫn gửi một câu `commentary` nói thật là chưa làm xong để GPT-Live không đoán kết quả.

## Phía FE

- Model: `gateway.experimental_realtime("openai/gpt-live-1.1")` từ `ai`, `api: { token: "/api/meal-planner/voice/session" }`.
- Câu chào đầu phiên dùng `fullName` của người dùng (gọi bằng tên) nếu có.
- `sessionConfig`: `instructions` theo template GPT-Live (giữ các mục `Backchannel policy`, `Interruption policy`, `Delegation policy`), `providerOptions.openai.delegation = { type: "client" }` và một tin nhắn `developer` chào đầu phiên trong `providerOptions.openai.input`. AI Gateway chỉ nhận `delegation` đúng `{ type: "client" }` (không có `acknowledgement_delay_ms`).
- CSP `connect-src` cần `wss://ai-gateway.vercel.sh`; `Permissions-Policy` cần `microphone=(self)`.
- Thời lượng phiên chỉ được giới hạn ở FE (5 phút). Token không khóa được cấu hình phiên phía server; muốn khóa thì chuyển sang relay (`server-websocket`).
