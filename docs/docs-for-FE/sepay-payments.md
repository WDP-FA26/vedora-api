# SePay: gói Pro/Premium và thanh toán QR

Phạm vi triển khai từ `PAYMENT_FLOW_BLUEPRINT.md`: Banking QR + webhook,
payment intent, idempotency, purchase ledger và membership. Không port domain
marketplace, báo giá, credit hoặc ví nhà bán của dự án nguồn.

## Quy tắc được duyệt

- Pro: **49.000 VND / 30 ngày**. Premium: **99.000 VND / 30 ngày**.
- Mỗi ngày = 24 giờ. Gói bắt đầu tại `capturedAt` (thời điểm BE commit capture),
  không bắt đầu khi tạo QR hoặc dựa trên thời gian mở trình duyệt.
- Mua mới, kể cả mua lại cùng gói, thay thế thời hạn cũ ngay. Không cộng dồn,
  không prorate, không quy đổi thời gian còn lại. FE thông báo trước khi mua.
- Gói chỉ ghi nhận trạng thái: chưa cấp bất kỳ đặc quyền, role, credit hoặc
  giới hạn sử dụng nào. Không recurring/auto-renew. Hết hạn đọc thành FREE,
  không cần worker/cron/BullMQ.
- Price/duration do BE cấu hình; intent snapshot chúng. Thay giá/config ngân
  hàng không sửa intent cũ. Webhook match tài khoản/bank đã snapshot của intent.

## API (prefix `/api/v1`)

Các API người dùng dùng JWT của ACTIVE account; tạo intent yêu cầu email đã xác
minh. Dữ liệu chỉ thuộc chính tài khoản, kể cả Admin không đọc payment người
khác qua API người dùng. Không có API cho FE tự đánh dấu đã trả tiền.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/billing/plans` | `{paymentsEnabled, plans:[{code,name,priceVnd,durationDays}]}` |
| GET | `/billing/me` | `{membership:{planCode,startsAt,expiresAt},pendingPayment,recentPayments}` |
| POST | `/billing/payment-intents` | Header `Idempotency-Key`; body **chỉ** `{planCode:"PRO"}` hoặc PREMIUM |
| GET | `/payment-intents/:id` | Payment thuộc tài khoản, 404 cho ID không thuộc quyền |
| GET | `/payment-intents/:id/events` | SSE thuộc đúng người mua; dùng Authorization header, không token trong URL |
| POST | `/payment-intents/:id/cancel` | Hủy PENDING, lặp CANCELLED trả cùng kết quả; SUCCEEDED trả 409 |
| POST | `/payments/sepay/bank-transfer-webhook` | Banking callback, `Authorization: Apikey <key>`, không JWT |
| GET | `/admin/payments/webhook-receipts` | ADMIN: 50 receipt đã che dữ liệu gần nhất để đối soát |

`priceVnd` và `amount` là **chuỗi số nguyên VND**. Các ngày là ISO UTC; FE hiển
thị UTC+7. `recentPayments` là 20 lần thử gần nhất, không phải toàn bộ sao kê.
FREE trả `startsAt=null, expiresAt=null`; lịch sử thanh toán vẫn còn.

Payment trả `id`, `planCode`, `durationDays`, `amount`, `currency`, `status`,
`invoiceNumber`, `paymentCode`, `createdAt`, `paidAt`, `capturedAt`,
`cancelledAt`, `qr`. QR chỉ có khi PENDING và thanh toán đang bật:
`imageUrl`, `downloadUrl`, `bankCode`, `bankGateway`, `accountNumber`,
`accountHolder`, `storeName`, `transferContent`, `amount`, `currency`.
Không trả email/userId, provider reference hoặc raw callback.

Chỉ một PENDING intent mỗi tài khoản. Cùng plan + snapshot sẽ reuse; khác
plan/giá/thời hạn trả `409 PENDING_PAYMENT_CONFLICT`, phải tiếp tục/hủy intent
cũ trước. UUID key 8–200 ký tự, dùng lại key và body khi timeout/retry.
Khác body cùng key trả `409 IDEMPOTENCY_CONFLICT`. Key lưu bền cùng giao dịch,
không TTL 24h như blueprint nguồn; replay trả **trạng thái hiện tại** của intent
cũ kể cả đã hủy/thành công, không tạo purchase mới.

## Webhook và tính đúng đắn

Xác thực constant-time trước parse/capture. Banking payload theo
[SePay](https://docs.sepay.vn/tich-hop-webhooks.html): `id`, `gateway`,
`transactionDate` dạng `YYYY-MM-DD HH:mm:ss` (UTC+7), `accountNumber`,
`subAccount`, `code`, `content`, `transferType`, `transferAmount`, `referenceCode`.
Chỉ `in`, tiền nguyên dương safe integer, amount bằng **đúng** snapshot.
`gateway` so không phân biệt hoa/thường; account hoặc VA khớp chính xác, giữ
số 0 đầu. Nếu `code` có giá trị sau trim, luôn dùng mã đó; không lấy mã khác
trong `content` để thay thế khi mã provider không khớp.

Khi `code` thiếu/null/trống, BE tìm trong `content` tối đa 4096 ký tự đúng một
mã đầy đủ: prefix cấu hình viết liền + đúng 20 ký tự hex. Chấp nhận hoa/thường
và tối đa 3 dấu cách/tab ASCII giữa các ký tự suffix (kể cả ngay sau prefix),
phù hợp nội dung MoMo chèn khoảng trắng. Không xóa khoảng trắng toàn bộ memo,
không đoán mã thiếu, không dùng `description`, newline, NBSP hoặc dấu gạch thay
khoảng trắng. Mã phải có ranh giới riêng, không lấy 20 ký tự đầu của mã dài
hơn. Hai mã đầy đủ khác nhau thì bỏ qua, kể cả chỉ một mã có trong DB;
lặp lại cùng mã không gây mơ hồ. Mã khôi phục vẫn phải khớp chính xác intent,
bank/account/VA, số tiền và trạng thái như mã provider.

Fallback dùng `SEPAY_PAYMENT_CODE_PREFIX` hiện tại; đổi prefix có thể khiến
callback không có `code` của intent cũ cần đối soát thủ công. Giữ prefix ổn
định trong khi còn intent chờ. Không thay đổi độ dài mã ngẫu nhiên hoặc QR.

Advisory transaction lock theo provider transaction rồi payer, CAS PENDING,
unique provider transaction/intent/ledger/active key và CHECK ở DB bảo vệ
đồng thời. Cùng transaction cập nhật intent, ledger, membership, audit và
receipt; bất kỳ bước nào lỗi thì rollback tất cả. Callback lỗi DB trả non-2xx
để provider retry. Không gọi external notification trong capture transaction.

`{success:true}` là acknowledgement, **không đồng nghĩa đã capture**. Receipt
lưu outcome: CAPTURED, CAPTURED_FROM_CONTENT, DUPLICATE, NOT_INCOMING, ACCOUNT_MISMATCH,
PAYMENT_CODE_MISSING, PAYMENT_CODE_AMBIGUOUS, PAYMENT_INTENT_NOT_FOUND, AMOUNT_MISMATCH,
TRANSACTION_ALREADY_USED, PAYMENT_INTENT_ALREADY_SUCCEEDED,
PAYMENT_CANCELLED, ACCOUNT_UNAVAILABLE. Receipt không lưu raw body, sender,
content, account hay secret; chỉ ID provider, hash, outcome, intent và giờ nhận.
Đối soát Admin qua Swagger; chưa có UI đối soát riêng.

Giao dịch sau hủy, sai/thừa/thiếu tiền, mã không nhận diện, hoặc account đã
bị khóa/xóa không tự kích hoạt gói; lưu receipt để vận hành đối soát. Không tự
cộng nhiều lần chuyển thiếu, không tự hoàn tiền. Không tự hết hạn PENDING
hoặc xóa receipt/idempotency/history. Cần chính sách retention trước khi tăng
quy mô. Các khoản tiền dư/thừa và tranh chấp xử lý ngoài luồng tự động này.
`paidAt` là giờ provider, `capturedAt` là giờ ghi nhận; không có cửa sổ tuổi
callback riêng ngoài identity/state và snapshot.

## Cấu hình và triển khai

Mặc định `SEPAY_PAYMENT_ENABLED=false`: vẫn đọc gói/history, không tạo QR mới
hoặc nhận callback. Khi bật phải đủ bank config + API key >=16 ký tự, xem
`.env.example`. `SEPAY_QR_BANK_CODE` dùng trong QR (ví dụ VCB);
`SEPAY_BANK_GATEWAY` là tên trong payload (ví dụ Vietcombank), không giả định
hai giá trị là cùng chuỗi. Secret chỉ nằm ở BE, không đưa vào NEXT_PUBLIC.

1. Apply migration `20261023030000_sepay_memberships` qua migrate deploy.
2. Cấu hình tài khoản nhận tiền, bank/gateway, prefix và webhook API key ở BE.
3. Cấu hình webhook **Vedora** trên SePay: Có tiền vào, đúng tài khoản nhận,
   JSON, API Key, HTTPS URL cuối cùng
   `/api/v1/payments/sepay/bank-transfer-webhook`, không redirect/WAF.
   **Tắt “Chỉ gửi khi có mã thanh toán” và bỏ bộ lọc prefix VED của webhook này**
   để callback `code=null` từ MoMo tới được BE. Giữ xác thực API Key và lọc
   tài khoản/chiều tiền vào. Cấu hình nhận diện mã chung của SePay vẫn dùng
   prefix tương ứng và suffix 20 ký tự để nhận mã viết liền; không sửa các
   webhook ứng dụng khác. Xem [bộ lọc mã của SePay](https://developer.sepay.vn/vi/sepay-webhooks/cau-hinh-ma-thanh-toan).
4. FE trỏ NEXT_PUBLIC_API_URL tới BE và rebuild. CSP cho ảnh `https://vietqr.app`.
5. Kiểm tra bằng chức năng gửi thử của SePay rồi đối soát trạng thái server.

Đây là **Banking QR**, không có hosted gateway/IPN/return redirect. Không có
`SEPAY_ENVIRONMENT=sandbox` cho nhánh này: QR có thể nhận tiền thật. Dùng tài
khoản/callback fixture riêng khi kiểm thử; chưa có bằng chứng end-to-end với
tài khoản SePay/ngân hàng thật chỉ từ các test bên dưới.

Fallback BE không điền lại cột “Mã thanh toán” trên dashboard SePay. Những
callback cũ chưa từng gửi tới Vedora cũng không tự được xử lý sau deploy;
đối soát intent/receipt trước khi gửi lại webhook gốc từ SePay. Intent đã hủy,
sai số tiền hoặc tài khoản vẫn không được capture. Không tự sửa số tiền trong
callback hay tạo callback giả để ghi nhận tiền thật.

## FE

`/billing` xem gói hiện tại, giá server, giao dịch chờ và lịch sử. Liên kết từ
menu chính. `/payment/:intentId` hiện QR và thông tin do BE trả, kết nối SSE
khi PENDING; dừng khi terminal/rời trang. SSE là kênh chính, GET dự phòng 4s
khi mất kết nối và GET đối soát 30s để phục hồi sự kiện bị mất. “Tôi đã thanh toán” chỉ GET. Chỉ
SUCCEEDED mới hiện thành công và refetch membership; không tin query success.
Token là một phần SWR key. Đổi token remount màn hình, hủy request ghi đang
chạy, không để response cũ điều hướng tài khoản mới. Retry key lưu session
storage theo user + plan và giữ sau lỗi mạng; xóa sau response tạo thành công.

## Realtime và khả năng chuyển MongoDB

`PaymentEventsService` dùng Redis Pub/Sub, độc lập Prisma/PostgreSQL. Cùng
`PAYMENT_REDIS_URL` và `PAYMENT_EVENTS_CHANNEL` cho các API instance của cùng
một môi trường. Hai connection Redis mỗi instance được mở khi có stream hoặc
publish, tự reconnect; không ghi key, không dùng Redis để giữ token/tiền/job.
URL trống thì SSE báo unavailable và FE dùng GET. Compose kèm Redis, không mở
cổng Redis ra Internet; bản development chỉ bind loopback cho API chạy host.
Local API chạy host: `PAYMENT_REDIS_URL=redis://127.0.0.1:6379`.
Dokploy API chạy container: URL mặc định `redis://redis:6379`.
Nếu dùng Redis ngoài, cấu hình URL với credentials/TLS và quyền Pub/Sub phù hợp.

Publish sau khi capture/cancel transaction resolve thành công; rollback,
ignored và duplicate không phát thay đổi. Lỗi publish không làm webhook của
payment đã commit trả thất bại. Redis Pub/Sub không lưu/replay sự kiện
([at-most-once](https://redis.io/docs/latest/develop/pubsub/#delivery-semantics)),
nên kết nối/reconnect luôn GET đối soát; thêm GET 30s khi đang chờ để bù crash
giữa commit và publish. GET là nguồn trạng thái cuối cùng, không có client paid mutation.

Các SSE event:

- `stream.ready`: Redis subscriber sẵn sàng, GET để bù sự kiện đã bỏ lỡ.
- `stream.unavailable`: Redis/DB kiểm tra session lỗi, bật GET dự phòng.
- `payment.changed`: `{intentId}`, chỉ gửi đúng owner + intent; GET payment và membership.
- `ping`: mỗi 15s, `{connected:boolean}`; cũng xác thực lại JWT và ACTIVE account.
- `session.expired`: đóng stream, FE refresh session; tối đa 15s sau expiry/status change.

FE dùng fetch-event-source có Bearer header, không native EventSource với JWT
trong URL. Heartbeat không tới trong 35s thì chuyển fallback và reconnect.
Proxy phải hỗ trợ streaming, không buffering (`X-Accel-Buffering: no`) và giữ
idle timeout lớn hơn heartbeat. Không phát amount/email/raw bank payload qua SSE.
Môi trường staging/production dùng channel khác nhau nếu chung Redis: Pub/Sub
không cách ly theo Redis database index.

Khi đổi MongoDB, giữ transport Redis/SSE và hợp đồng invalidation. Riêng
`PaymentsService` hiện vẫn dùng Prisma PostgreSQL, advisory lock, CAS, Decimal,
unique/CHECK constraints. Chuyển database cần thay repository/transaction và
chiến lược chống trùng tương ứng (Mongo transaction cần replica set/sharded
cluster), cùng mapping ID nếu thay UUID bằng ObjectId; chưa có migration Mongo
trong thay đổi realtime này.

## Kiểm thử

```powershell
npm run build
npm run lint
npm test
$env:TEST_DATABASE_URL = "postgresql://user:password@localhost:5432/vedora_test"
npm run test:db -- test/payments.db-spec.ts
```

DB suite tạo/drop schema ngẫu nhiên trong DB test: idempotency đồng thời,
duplicate/reused event, cancel-vs-capture, rollback có chủ đích, ownership,
snapshots, UTC+7, ledger, thay thế gói và expiry. Không reset DB ứng dụng.
Thêm fixture `code=null` có khoảng trắng kiểu MoMo: capture, explicit code
ưu tiên, sai/thừa/thiếu tiền, sai bank/account/chiều tiền, mã mơ hồ/thiếu/không
tồn tại, hủy và callback đồng thời. Không gửi tiền thật khi chạy suite.
