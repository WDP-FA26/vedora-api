# Trợ lý giọng nói của meal planner

Người dùng nói chuyện trực tiếp (full duplex) với mô hình giọng nói **GPT-Live 1.1** qua **Vercel AI Gateway**. Phần việc thật (thực đơn, công thức, nhật ký, chỉ số cơ thể) vẫn do **agent planner hiện tại** (Claude Haiku) làm ở API, với cùng tool, quota và lịch sử thread như chat chữ (bỏ qua bước moderation `decide` riêng để giảm latency).

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

Cấp token ngắn hạn (`vcst_…`, 60 giây để mở WebSocket; phiên đã mở không bị cắt khi token hết hạn). Cần Bearer token, có rate limit theo user. Body tùy chọn `{ "threadId": "…" }` để API bắn ngầm warm-up prompt cache (1h TTL + sticky session) cho planner trong lúc trình duyệt mở mic và GPT-Live chào người dùng.

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
  "requestId": "item_9tA2bF3h7K9m2P5q8R1s4"
}
```

- `message`: lời người dùng đã chép từ transcript (`transcript-fragment` của speaker `user` từ sau delegation trước). Tối đa bằng giới hạn tin nhắn chat.
- `threadId`: thread chat để lưu lượt này. FE gửi thread đang mở trong khung chat, rồi tải lại thread đó (`GET /meal-plan/chat/threads/:threadId`) để lượt nói hiện ngay trong khung chat. Bỏ trống thì API tạo thread mới.
- `requestId`: nên dùng delegation id để quota không bị trừ hai lần khi gửi lại.
- `screen` (tùy chọn, nên gửi): trạng thái trang lúc người dùng nói, để agent hiểu "món này", "đóng nó đi", "bước tiếp theo", "cuộn xuống nữa". `{ weekStart, day?, panel: "none" | "recipe" | "eatingLog" | "bodyMetrics", recipeId?, recipeSection?: "top" | "ingredients" | "steps", recipeStep?: number, eatingLogDate?, scrollState?: { percent: number, atTop: boolean, atBottom: boolean } }`. API tự lấy tên món từ danh mục theo `recipeId`.
- Tìm web: tắt ở chế độ voice để giữ độ trễ thấp (không gọi `webSearch` hay `requestWebSearch`). `webSearchRequest` cũ vẫn được nhận nhưng bị bỏ qua.

Đọc stream bằng `parseJsonEventStream` + `readUIMessageStream` của `ai`. Mỗi phần tool chuyển sang `output-available` là một việc đã xong, FE phản chiếu ngay lên màn hình:

| tool | output | FE làm gì |
| --- | --- | --- |
| `endCall` | `{ ended: true }` | người dùng tạm biệt: agent có thể dừng ngay sau bước tool (nếu `text` rỗng FE tự tạo lời nhắc chào tạm biệt), đợi GPT-Live nói xong rồi đóng cuộc gọi |
| `setScreen` | `{ applied, view, recipeId, title, section, step, scroll, weekStart, day, date, metrics, problem, done? }` | `applied: false` thì không làm gì (`problem` là lý do cho agent). `view: recipe`: mở công thức `recipeId` (hoặc tra trực tiếp bằng `query`), không hiện ảnh, cuộn tới `step` (bước 1-based, có highlight) hoặc `section` (`top`, `ingredients`, `steps`). `view: calendar`: đóng mọi panel, chuyển tới tuần `weekStart` và chọn `day` nếu có. `view: eatingLog`: mở nhật ký ở `date` (null = hôm nay). `view: bodyMetrics`: mở tab BMI. `scroll` (`up`, `down`, `top`, `bottom`): cuộn mượt nội dung của view đang active. Khi `done: true` agent có thể dừng sau bước tool và FE tự tóm tắt ngắn từ `output` nếu `text` rỗng |
| `logMeal` | `{ entry }` (như `POST /meal-plan/log`) | làm mới nhật ký, mở ngày `entry.date` |
| `updateBodyMetrics` | `{ heightCm, weightKg, targetWeightKg, bmi, bmiCategory, dailyCalorieTarget }` | làm mới `/dietary/nutrition`, mở tab BMI |
| `undoLastChange` | `{ messageId, weeks: [{ weekStart, restored, skipped, droppedDishes }] }` | làm mới thực đơn, chuyển tới ngày vừa khôi phục |
| `fillSlots`, `editPlan`, `autoBalancePlan`, `verifyMealPlanAllergies` | như chat chữ | làm mới thực đơn |
| `updateMemory` | như chat chữ | làm mới `/dietary/me` |

Mở một panel (công thức, nhật ký, chỉ số cơ thể) thì FE đóng các panel khác đang mở. Các tool `showRecipe`, `showPlanDay`, `closeScreen`, `openEatingLog`, `showBodyMetrics` của các lượt cũ chỉ còn để đọc lịch sử; lượt mới không gọi chúng nữa.

Phần `text` của tin nhắn cuối là câu trả lời ngắn để GPT-Live diễn đạt lại: gửi bằng `context-append` với `delegationId` của lượt và `providerOptions.openai.channel = "commentary"` (tối đa 500 token mỗi lần). Lượt chạy lâu (trên 6 giây) có thể gửi thêm một câu `commentary` ngắn cho mỗi thay đổi đã lưu.

`undoLastChange` đưa thực đơn về như trước lần thay đổi gần nhất chưa hoàn tác trong thread, không xóa tin nhắn (nút "Quay lại" của chat vẫn dùng được). Chế độ voice không có `askUser`: khi cần người dùng chọn, planner hỏi bằng lời.

## POST /meal-plan/voice/interruptions

Bước phân loại bằng decision model đã được tắt để giảm độ trễ ở chế độ voice; endpoint hiện trả ngay `{ "action": "supersede" }` (không gọi LLM, không tính vào quota chat). Phía FE cũng bỏ qua bước gọi endpoint này và hủy trực tiếp lượt đang chạy khi có delegation mới.

**Hủy:** đóng request (abort) khi người dùng nói tiếp hoặc kết thúc cuộc gọi; agent dừng, những gì đã lưu vẫn giữ. FE báo cho GPT-Live bằng `context-append` kênh `thinking` cho delegation cũ.

Lỗi (trước khi stream bắt đầu, dạng JSON như mọi endpoint): `429 AI_QUOTA_EXCEEDED` hết lượt AI, `429` gọi quá nhanh, `503` model lỗi, `404` thread không thuộc người dùng. Lỗi giữa stream đến dưới dạng phần `error`. Khi lỗi, FE vẫn gửi một câu `commentary` nói thật là chưa làm xong để GPT-Live không đoán kết quả.

## Phía FE

- Model: `gateway.experimental_realtime("openai/gpt-live-1.1")` từ `ai`, `api: { token: "/api/meal-planner/voice/session" }`.
- Câu chào đầu phiên dùng `fullName` của người dùng (gọi bằng tên) nếu có.
- `sessionConfig`: `instructions` theo template GPT-Live (giữ các mục `Backchannel policy`, `Interruption policy`, `Delegation policy`), `providerOptions.openai.delegation = { type: "client" }` và một tin nhắn `developer` chào đầu phiên trong `providerOptions.openai.input`. AI Gateway chỉ nhận `delegation` đúng `{ type: "client" }` (không có `acknowledgement_delay_ms`).
- CSP `connect-src` cần `wss://ai-gateway.vercel.sh`; `Permissions-Policy` cần `microphone=(self)`.
- Thời lượng phiên chỉ được giới hạn ở FE (5 phút). Token không khóa được cấu hình phiên phía server; muốn khóa thì chuyển sang relay (`server-websocket`).
