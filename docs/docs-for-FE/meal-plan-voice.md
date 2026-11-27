# Trợ lý giọng nói của meal planner

Người dùng **Pro còn hiệu lực** nói chuyện trực tiếp (full duplex) với mô hình giọng nói **GPT-Live 1.1** qua **Vercel AI Gateway**. Phần việc thật (thực đơn, công thức, nhật ký, chỉ số cơ thể) vẫn do **agent planner hiện tại** (Claude Haiku) làm ở API, dùng chung tool và lịch sử thread với chat chữ (bỏ qua bước moderation `decide` riêng để giảm latency). Mỗi yêu cầu gửi sang planner qua voice dùng chung một lượt AI chữ, không có hạn mức phút theo chu kỳ. Pro đã mua trước đó cũng áp dụng; Free/Plus bị từ chối. Admin giữ cơ chế Pro và miễn chặn quota hiện có.

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

Lỗi: `401` chưa đăng nhập, `403 PRO_REQUIRED` không có Pro còn hiệu lực, `429 AI_QUOTA_EXCEEDED` hết lượt AI chữ, `429 TOO_MANY_REQUESTS` gọi quá nhanh, `503 SERVICE_UNAVAILABLE` chưa cấu hình voice. API kiểm tra Pro và còn lượt trước khi cấp token, nhưng mở session không trừ lượt. Proxy FE cùng origin ánh xạ riêng `AI_QUOTA_EXCEEDED` sang 402 để trình realtime hiển thị đúng lý do.

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

Lỗi (trước khi stream bắt đầu, dạng JSON như mọi endpoint): `403 PRO_REQUIRED` gói không còn là Pro hoặc đã hết hạn, `429 AI_QUOTA_EXCEEDED` hết lượt AI chữ, `429 TOO_MANY_REQUESTS` gọi quá nhanh, `503` model lỗi, `404` thread không thuộc người dùng. API kiểm tra lại quyền và giữ chỗ quota ở mỗi lượt, kể cả khi đã có token phiên. Lỗi giữa stream đến dưới dạng phần `error`. Khi lỗi, FE gửi câu `commentary` nói thật là chưa làm xong để GPT-Live không đoán kết quả; nếu hết quota thì dừng kết nối và hiện hướng dẫn trên giao diện.

## Phía FE

- Model: `gateway.experimental_realtime("openai/gpt-live-1.1")` từ `ai`, `api: { token: "/api/meal-planner/voice/session" }`.
- Câu chào đầu phiên dùng `fullName` của người dùng (gọi bằng tên) nếu có.
- `sessionConfig`: `instructions` theo template GPT-Live (giữ các mục `Backchannel policy`, `Interruption policy`, `Delegation policy`), `providerOptions.openai.delegation = { type: "client" }` và một tin nhắn `developer` chào đầu phiên trong `providerOptions.openai.input`. AI Gateway chỉ nhận `delegation` đúng `{ type: "client" }` (không có `acknowledgement_delay_ms`).
- CSP `connect-src` cần `wss://ai-gateway.vercel.sh`; `Permissions-Policy` cần `microphone=(self)`.
- FE kiểm tra gói và lượt còn lại trước khi mở micro; Free/Plus hiện hướng nâng cấp. Khi một lượt kết thúc (thành công, lỗi hoặc hủy), FE đọc lại `/billing/me`. Không ngắt câu trả lời cuối chỉ vì lượt còn lại vừa về 0; yêu cầu kế tiếp bị quota chặn.
- Request/idempotency vẫn thuộc bucket `VOICE` để giữ chống trùng giữa các kênh; request voice mới có `usesTextQuota: true` và được tính chung với bucket `TEXT` khi kiểm tra/hiển thị quota chữ. Request voice cũ không có cờ không bị tính lại; không cần migration/backfill hoặc env mới.
- Reservation và commit/refund dùng cùng cơ chế chat chữ: thành công trừ một lượt, lỗi hoặc hủy trước hoàn tất hoàn reservation. Retry cùng request đã hoàn tất không trừ thêm; các tool/subagent bên trong một delegation không trừ thành nhiều lượt. Những câu GPT-Live tự đọc từ công thức đang mở, lời chào và lời đệm không gọi planner nên không tạo lượt quota backend.
- Giới hạn kỹ thuật một phiên theo `NEXT_PUBLIC_VOICE_MAX_SECONDS` ở FE, không phải quota phút của gói. Token chỉ giới hạn thời gian mở WebSocket, không tự cắt một kết nối đã mở. Quyền session/turn được kiểm tra ở BE; kiến trúc kết nối trực tiếp Gateway hiện có được giữ nguyên.

## Xác minh quota chữ ngày 28/11/2026

- 67 kiểm thử BE cho usage, stream settlement, voice service và planner; 25 kiểm thử HTTP cho quota voice và cấp gói với MongoDB thật: pass.
- FE: 48 unit test voice và 22 Playwright cho gói/cấp gói, gồm Pro hết quota không mở micro hay gọi session: pass. Build BE/FE và lint pass.
- Image production Node 26 chạy trong Docker: kiểm tra trừ chung lượt, hoàn/retry, chống trùng, không tính lại voice cũ và race lấy lượt cuối giữa voice/chữ: pass. HTTP billing/session/turns giữ kết quả đúng sau restart; fixture riêng đã dọn.
- Không gọi dịch vụ AI có tính phí trong lần kiểm tra này; kiểm thử stream dùng model giả và dữ liệu quota trong MongoDB thật.
