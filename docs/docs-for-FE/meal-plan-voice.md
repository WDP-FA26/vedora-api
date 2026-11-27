# Trợ lý giọng nói của meal planner

Người dùng **Pro còn hiệu lực** nói chuyện trực tiếp (full duplex) với mô hình giọng nói **GPT-Live 1.1** qua **Vercel AI Gateway**. Phần việc thật (thực đơn, công thức, nhật ký, chỉ số cơ thể) vẫn do **agent planner hiện tại** (Claude Haiku) làm ở API, dùng chung tool và lịch sử thread với chat chữ (bỏ qua bước moderation `decide` riêng để giảm latency). Voice không trừ lượt AI chữ và không có hạn mức phút theo chu kỳ. Pro đã mua trước đó cũng được dùng; Free, Plus và tài khoản admin không có Pro đều bị từ chối.

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

Lỗi: `401` chưa đăng nhập, `403 PRO_REQUIRED` không có Pro còn hiệu lực, `429 TOO_MANY_REQUESTS` gọi quá nhanh, `503 SERVICE_UNAVAILABLE` chưa cấu hình voice. API kiểm tra quyền Pro trước khi cấp token; không phụ thuộc số lượt AI chữ còn lại.

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
- `screen` (tùy chọn, nên gửi): trạng thái trang lúc người dùng nói, để agent hiểu "món này", "đóng nó đi", "bước tiếp theo", "cuộn xuống nữa". `{ weekStart, day?, panel: "none" | "recipe" | "eatingLog" | "bodyMetrics" | "shoppingList", recipeId?, recipeSection?: "top" | "ingredients" | "steps", recipeStep?: number, eatingLogDate?, scrollState?: { percent: number, atTop: boolean, atBottom: boolean } }`. API tự lấy tên món từ danh mục theo `recipeId`.
- Tìm web: agent có tool `webSearch` nhưng phải hỏi xin phép người dùng bằng lời trước khi tìm (không dùng nút `requestWebSearch`).

Đọc stream bằng `parseJsonEventStream` của `ai` (`uiMessageChunkSchema`). Ngoài các chunk tiêu chuẩn (`text-delta`, `finish`, `error`), API phát kèm các data part transient (`transient: true`, không lưu vào lịch sử chat) ngay khi tool chạy xong để FE không phải mirror schema output của tool:

| data chunk | payload | FE làm gì |
| --- | --- | --- |
| `data-screen` | `{ focus, close, scroll? }` | Mở/đóng panel (`recipe`, `eatingLog`, `bodyMetrics`, `shoppingList`, `planDay`), cuộn mượt (`up`, `down`, `top`, `bottom`) |
| `data-state` | `{ invalidate?: ("plan" \| "shoppingList" \| "mealLog" \| "nutrition" \| "dietary")[], patch?: { nutrition? } }` | Cập nhật / invalidate SWR cache (dùng chung cho cả Text Chat & Voice) |
| `data-progress` | `{ text }` | Gửi kênh `thinking`; GPT-Live tự quyết định có nhắc người dùng hay không |
| `data-end-call` | `{}` | Đánh dấu cuộc gọi kết thúc sau khi GPT-Live đọc lời chào tạm biệt |
| `data-summary` | `{ text }` | Câu tóm tắt tiếng Việt ngắn (chỉ phát trước `finish` khi tool nhanh kết thúc mà không sinh `text`) |

Mở một panel (công thức, nhật ký, chỉ số cơ thể) thì FE đóng các panel khác đang mở.

Phần `text` của tin nhắn cuối (hoặc `data-summary` nếu `text` rỗng) là câu trả lời ngắn để GPT-Live diễn đạt lại: gửi ngay khi nhận `finish` bằng `context-append` với `delegationId` của lượt và `providerOptions.openai.channel = "commentary"` (tối đa 500 token mỗi lần).

`undoLastChange` đưa thực đơn về như trước lần thay đổi gần nhất chưa hoàn tác trong thread, không xóa tin nhắn (nút "Quay lại" của chat vẫn dùng được). Chế độ voice không có `askUser`: khi cần người dùng chọn, planner hỏi bằng lời.

**Hủy:** đóng request (abort) khi người dùng nói tiếp hoặc kết thúc cuộc gọi; agent dừng, những gì đã lưu vẫn giữ. FE báo cho GPT-Live bằng `context-append` kênh `thinking` cho delegation cũ và làm mới lại các cache.

Lỗi (trước khi stream bắt đầu, dạng JSON như mọi endpoint): `403 PRO_REQUIRED` gói không còn là Pro hoặc đã hết hạn, `429` gọi quá nhanh, `503` model lỗi, `404` thread không thuộc người dùng. API kiểm tra lại quyền ở mỗi lượt, kể cả khi người dùng đã có token phiên trước đó. Lỗi giữa stream đến dưới dạng phần `error`. Khi lỗi, FE vẫn gửi một câu `commentary` nói thật là chưa làm xong để GPT-Live không đoán kết quả.

## Phía FE

- Model: `gateway.experimental_realtime("openai/gpt-live-1.1")` từ `ai`, `api: { token: "/api/meal-planner/voice/session" }`.
- Câu chào đầu phiên dùng `fullName` của người dùng (gọi bằng tên) nếu có.
- `sessionConfig`: `instructions` theo template GPT-Live (giữ các mục `Backchannel policy`, `Interruption policy`, `Delegation policy`), `providerOptions.openai.delegation = { type: "client" }` và một tin nhắn `developer` chào đầu phiên trong `providerOptions.openai.input`. AI Gateway chỉ nhận `delegation` đúng `{ type: "client" }` (không có `acknowledgement_delay_ms`).
- CSP `connect-src` cần `wss://ai-gateway.vercel.sh`; `Permissions-Policy` cần `microphone=(self)`.
- FE kiểm tra gói trước khi mở micro và hiện hướng nâng cấp cho Free/Plus. Voice vẫn lưu request/idempotency trong bucket `VOICE`, tách khỏi `TEXT`; không ghi hạn mức phút hoặc ledger tính giây.
- Giới hạn kỹ thuật một phiên theo `NEXT_PUBLIC_VOICE_MAX_SECONDS` ở FE, không phải quota phút của gói. Token chỉ giới hạn thời gian mở WebSocket, không tự cắt một kết nối đã mở. Quyền session/turn được kiểm tra ở BE; kiến trúc kết nối trực tiếp Gateway hiện có được giữ nguyên.
