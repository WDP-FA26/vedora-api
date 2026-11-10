# Subscription Plus / Pro — catalogue v2

## Quy tắc đã chốt

| Gói | Giá / thời hạn | AI văn bản dùng chung | Tạo/chỉnh ảnh AI |
| --- | --- | --- | --- |
| FREE | Miễn phí | 5 lượt/ngày, đặt lại 00:00 Asia/Bangkok | 0 |
| PLUS | 49.000 VND / 30 ngày | 300 lượt/chu kỳ | 10 lượt/chu kỳ |
| PRO | 99.000 VND / 30 ngày | 900 lượt/chu kỳ | 40 lượt/chu kỳ |

Mỗi lần thanh toán thành công đều thu đủ giá gói và bắt đầu lại chu kỳ tại
`capturedAt`, kể cả mua lại cùng gói, Plus → Pro hoặc Pro → Plus. Một ngày là
24 giờ. Không prorate, cộng dồn thời gian/lượt, hay giữ số dư của chu kỳ trước.
Tạo QR chưa đổi quyền lợi; chỉ webhook hợp lệ commit capture mới đổi gói.
Ví dụ Plus còn 15 ngày lên Pro vẫn thanh toán đủ 99.000 VND và nhận 30 ngày
Pro mới, cùng hạn mức mới 900/40. Callback trùng không đặt lại hạn mức lần hai.

SePay hiện dùng chuyển khoản QR trả trước. Không tự động trừ tiền, recurring,
worker hoặc BullMQ. Khi hết hạn, API đọc thành FREE và dùng bucket ngày hiện
tại; dữ liệu, nội dung, công thức và thực đơn cũ vẫn dùng được. Các tính năng
cộng đồng, quản lý thực đơn thủ công và danh sách đi chợ không bị paywall.

## Phiên bản và dữ liệu trước khi đổi tên

Không sửa hoặc xóa bản ghi tài chính đã lưu:

- Intent thiếu `planVersion` hoặc có version 1: `PRO` cũ → quyền lợi PLUS;
  `PREMIUM` cũ → quyền lợi PRO. Giữ nguyên số tiền và thời hạn đã snapshot.
- Intent mới có `planVersion:2`: `PLUS` → Plus; `PRO` → Pro mới.
- API trả `planCode` theo tên hiện tại và `purchasedPlanName` theo tên khi mua
  (`Pro (gói cũ)` / `Premium (gói cũ)` cho lịch sử). Giữ enum PREMIUM trong DB
  để đọc lịch sử, nhưng từ chối tạo purchase mới bằng mã đó.
- Intent v2 snapshot cả giá, thời hạn và hai hạn mức AI. Đổi policy sau này
  không sửa quyền lợi của chu kỳ đã mua. Intent cũ chưa có snapshot hạn mức
  được hưởng hạn mức hiện tại của tier tương ứng.
- Counter `ai_usage` cũ được giữ nguyên, không dùng để tính quota v2. Quota
  subscription dùng `ai_requests`; thành viên hiện tại bắt đầu bộ đếm mới khi
  triển khai, gắn vào chu kỳ đang còn hạn.

## API và UI

`GET /billing/plans` trả `planVersion:2`, `paymentsEnabled`, `freeLimits`
(`textLimit`, `imageLimit`) và hai gói PLUS/PRO với giá/độ dài/hạn mức server.

`POST /billing/payment-intents` nhận đúng `{ "planCode":"PLUS", "planVersion":2 }`
hoặc PRO, cùng header `Idempotency-Key`. Version bắt buộc để client cũ không
vô tình mua Pro mới khi đang hiểu PRO là gói 49.000 VND. Body không nhận giá,
thời hạn hay hạn mức từ FE. Pending intent chỉ reuse khi cùng tier và snapshot.

`GET /billing/me` bổ sung `usage.text` và `usage.images`:

```json
{
  "used": 3,
  "limit": 300,
  "remaining": 297,
  "resetsAt": "2026-12-09T10:00:00.000Z",
  "period": "CYCLE"
}
```

`period` là DAY cho FREE và CYCLE cho paid. FE hiển thị giờ UTC+7, refetch
khi thanh toán/cancel/SSE, khi focus, định kỳ và khi gói hết hạn. Trang billing
so sánh ba mức, hiển thị gói hiện tại và hai hạn mức riêng, xác nhận rõ số tiền
và việc kết thúc chu kỳ cũ trước khi tạo QR. Lịch sử hiển thị `purchasedPlanName`.
Không dựa vào JWT hay localStorage để quyết định quyền lợi; BE kiểm tra mọi lần gọi.

## AI và tính đồng thời

- TEXT dùng chung cho `/meal-plan/chat` (bao gồm hỏi dinh dưỡng của thành viên)
  và `/blogs/ai/chat`. IMAGE tính riêng cho mỗi lần generate/edit ảnh thành công.
  Guest demo `/nutrition-chat` giữ nguyên captcha và giới hạn riêng hiện có.
- Một lượt văn bản là một logical user turn; các editor-tool continuation
  hợp lệ không trừ thêm lượt văn bản. Có tối đa 8 request khác nhau trong một turn.
- Request giữ chỗ trước khi gọi model. MongoDB transaction dùng cùng payer lock
  với capture để gắn request trọn vẹn vào một chu kỳ. Tính cả chỗ đang giữ khi
  quyết định quota, tránh vượt hạn mức khi nhiều API instance xử lý đồng thời.
- Hoàn thành stream/ảnh thì commit lượt; model lỗi hoặc bị từ chối thì refund
  bằng ticket của đúng request. Lỗi cũ không thể hoàn vào chu kỳ mới sau nâng gói.
- Stream xử lý tối đa 5 phút; lease giữ chỗ 10 phút. Nếu worker chết, lease hết
  tự ngừng chiếm quota khi đọc/tạo request sau đó, không cần background job.
- `/meal-plan/chat` nhận `requestId` ổn định (ID của user message, tối đa 100 ký tự).
  Blog lấy ID user message và chat session từ payload AI SDK. Hash prompt/body
  được lưu, không lưu raw prompt hoặc nội dung hội thoại trong quota records.
- Cùng ID nhưng đổi prompt: 409 IDEMPOTENCY_CONFLICT. Request còn chạy:
  409 AI_REQUEST_IN_PROGRESS. Request đã xử lý: 409 AI_REQUEST_ALREADY_PROCESSED,
  không chạy model hoặc trừ thêm lượt. Chưa lưu/replay câu trả lời AI ở server;
  FE giữ kết quả đã nhận và không retry mù một request đã hoàn tất.
- Continuation không có turn gốc, vượt giới hạn hoặc sang chu kỳ khác:
  409 AI_REQUEST_EXPIRED. Bắt đầu yêu cầu mới. Hết quota: 429 AI_QUOTA_EXCEEDED;
  công cụ ảnh trả IMAGE_QUOTA_EXCEEDED. FE hướng tới `/billing`.

## Triển khai

1. Cấu hình giá mới bằng `SUBSCRIPTION_PLUS_PRICE_VND=49000` và
   `SUBSCRIPTION_PRO_PRICE_VND=99000`, thời hạn `BILLING_DURATION_DAYS=30`.
   Hai biến BILLING_PRO_PRICE_VND/BILLING_PREMIUM_PRICE_VND và các biến
   BLOG_AI_DAILY_* cũ không còn điều khiển catalog/quota mới. Nếu từng tùy chỉnh
   giá, chuyển giá phù hợp sang bộ biến mới trước khi deploy.
2. MongoDB phải chạy replica set. Mongoose thêm collection/index ai_requests;
   không cần script sửa dữ liệu cũ. Đừng xóa lịch sử để đổi tên gói.
3. Phối hợp deploy BE và FE v2. Client cũ không hiểu PLUS/contract mới; version
   bắt buộc giúp từ chối an toàn các purchase cũ thay vì diễn giải nhầm PRO.
4. Giữ bộ lọc có mã của webhook SePay và prefix từ env + hậu tố 6 ký tự như cũ.
5. Kiểm thử fixture trước; code/unit/Docker không thay thế kiểm chứng cấu hình
   webhook/ngân hàng thật và đo chi phí model trước khi mở bán rộng rãi.

```powershell
npm run build
npm run lint
npm test
npm run test:db -- test/db/payments.db-spec.ts test/db/subscriptions.db-spec.ts
```

Các suite MongoDB tạo database ngẫu nhiên và chỉ drop database test của chúng.
