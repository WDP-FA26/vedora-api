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
`subAccount`, `code`, `transferType`, `transferAmount`, `referenceCode`.
Chỉ `in`, tiền nguyên dương safe integer, amount bằng **đúng** snapshot.
`gateway` so không phân biệt hoa/thường; account hoặc VA khớp chính xác, giữ
số 0 đầu. Chỉ dùng `code`, không tự dò trong `content`; cấu hình SePay trích
đúng prefix VED (hoặc prefix do BE cấu hình).

Advisory transaction lock theo provider transaction rồi payer, CAS PENDING,
unique provider transaction/intent/ledger/active key và CHECK ở DB bảo vệ
đồng thời. Cùng transaction cập nhật intent, ledger, membership, audit và
receipt; bất kỳ bước nào lỗi thì rollback tất cả. Callback lỗi DB trả non-2xx
để provider retry. Không gọi external notification trong capture transaction.

`{success:true}` là acknowledgement, **không đồng nghĩa đã capture**. Receipt
lưu outcome: CAPTURED, DUPLICATE, NOT_INCOMING, ACCOUNT_MISMATCH,
PAYMENT_CODE_MISSING, PAYMENT_INTENT_NOT_FOUND, AMOUNT_MISMATCH,
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
3. Cấu hình webhook SePay Có tiền vào, JSON, API Key, prefix code, HTTPS URL
   cuối cùng `/api/v1/payments/sepay/bank-transfer-webhook`, không redirect/WAF.
4. FE trỏ NEXT_PUBLIC_API_URL tới BE và rebuild. CSP cho ảnh `https://vietqr.app`.
5. Kiểm tra bằng chức năng gửi thử của SePay rồi đối soát trạng thái server.

Đây là **Banking QR**, không có hosted gateway/IPN/return redirect. Không có
`SEPAY_ENVIRONMENT=sandbox` cho nhánh này: QR có thể nhận tiền thật. Dùng tài
khoản/callback fixture riêng khi kiểm thử; chưa có bằng chứng end-to-end với
tài khoản SePay/ngân hàng thật chỉ từ các test bên dưới.

## FE

`/billing` xem gói hiện tại, giá server, giao dịch chờ và lịch sử. Liên kết từ
menu chính. `/payment/:intentId` hiện QR và thông tin do BE trả, poll 4 giây
khi PENDING; dừng khi terminal/rời trang. “Tôi đã thanh toán” chỉ GET. Chỉ
SUCCEEDED mới hiện thành công và refetch membership; không tin query success.
Token là một phần SWR key. Đổi token remount màn hình, hủy request ghi đang
chạy, không để response cũ điều hướng tài khoản mới. Retry key lưu session
storage theo user + plan và giữ sau lỗi mạng; xóa sau response tạo thành công.

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
