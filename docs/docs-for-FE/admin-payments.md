# Admin: thanh toán và subscription

FE: `/admin/payments`, chi tiết `/admin/payments/:id`. Backend dùng các endpoint dưới `/admin/payments` (sau API prefix). Tất cả endpoint yêu cầu JWT của tài khoản ADMIN đang hoạt động, kiểm tra role từ DB; trả `Cache-Control: private, no-store`, `Vary: Authorization`.

Đây là chức năng tra cứu. Dữ liệu đơn, webhook, quota và gói đang dùng không bị sửa khi xem báo cáo hoặc xuất CSV. Không thêm tự hết hạn đơn, force-paid, hoàn tiền hoặc background job.

## Quy tắc số liệu

- Đơn có ba trạng thái thực tế `PENDING`, `SUCCEEDED`, `CANCELLED`. Hết 30 ngày là hết chu kỳ subscription, không phải một trạng thái EXPIRED của đơn.
- Danh sách/CSV lọc theo `createdAt`. Tiền đã xác nhận lọc theo **`capturedAt` của BE**, không theo ngày tạo đơn hoặc `paidAt` ngân hàng cung cấp. Một đơn tạo ngoài khoảng ngày có thể vẫn đóng góp vào tiền đã xác nhận trong khoảng đó.
- Chỉ cộng `SUCCEEDED`, currency `VND`, có `capturedAt` trong khoảng. Tổng lấy từ intent đã capture, không đếm receipt CAPTURED; webhook gửi lặp không làm tăng tiền. Đây là tổng tiền ghi nhận trước phí/thuế, không phải lợi nhuận hoặc số dư ngân hàng. Hoàn tiền ngoài hệ thống chưa được khấu trừ.
- Tiền trả về dưới dạng **chuỗi số nguyên**. Mongo cộng bằng Decimal128 từ BSON Long; FE dùng BigInt để định dạng, CSV giữ chuỗi nguyên. Không chuyển tiền sang JS Number để tính hoặc hiển thị.
- Mọi filter đơn (`status`, `plan`, `userId`, `q`) áp dụng cho cả số đơn tạo và số tiền capture, với hai mốc ngày riêng. Chọn PENDING/CANCELLED sẽ không có tiền đã xác nhận.
- Snapshot subscription **toàn hệ thống**, độc lập mọi filter đơn và khoảng ngày. Chỉ đếm tài khoản tồn tại, `ACTIVE`, đã xác minh email và còn hạn từ **lần SUCCEEDED mới nhất**, sắp xếp `capturedAt DESC, _id DESC`. Không đếm nhiều lần khi mua lại/nâng/hạ gói, không chọn gói cao nhất, không quay lại một chu kỳ cũ còn hạn nếu chu kỳ mới nhất đã hết.
- Snapshot dùng chu kỳ đã mua `durationDays × 24 giờ`, bắt đầu ở capture. `expiresAt === now` đã hết hạn. Phân biệt gói của đơn lịch sử với gói hiện tại.
- Legacy v1 hoặc thiếu `planVersion`: PRO cũ → Plus, PREMIUM cũ → Pro. v2: PLUS → Plus, PRO → Pro. Giữ `originalPlanCode`, tên mua cũ, giá, thời hạn và quota snapshot; không sửa dữ liệu tài chính để đổi tên.
- Các aggregation/report đọc gần nhau, không phải snapshot transaction toàn hệ thống; số liệu có thể thay đổi khi có thanh toán mới. Bấm tải lại để đối soát trạng thái mới.

## Query chung của đơn và overview

| Trường       | Quy tắc                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from`, `to` | Có cả hai hoặc không có; YYYY-MM-DD hợp lệ, tăng dần, tối đa 90 ngày kể cả hai đầu                                                                                   |
| `status`     | PENDING / SUCCEEDED / CANCELLED                                                                                                                                      |
| `plan`       | PLUS / PRO theo tên hiện tại, bao gồm mapping legacy                                                                                                                 |
| `userId`     | UUID của tài khoản, kể cả tài khoản đã bị xóa                                                                                                                        |
| `q`          | Tìm **chính xác**, trim, tối đa 200 ký tự: ID đơn/người dùng, invoice, payment code, provider transaction ID, username hoặc email; không phải tìm gần đúng hay regex |

Mặc định 30 ngày gần nhất theo Asia/Bangkok (UTC+7). Khoảng là từ đầu ngày `from` đến trước đầu ngày kế tiếp `to`. Tìm tên/email/mã không phân biệt hoa thường; UUID được chuẩn hóa chữ thường. Query không hỗ trợ bị từ chối, không âm thầm bỏ qua.

## API

### `GET /admin/payments/overview`

Nhận query chung, trả:

- `generatedAt`, `currency:"VND"`, `range`, `orderDateBasis:"createdAt"`, `revenueDateBasis:"capturedAt"`.
- `createdOrders`: tổng đơn được tạo khớp filter và số PENDING/SUCCEEDED/CANCELLED hiện tại; không phải lịch sử chuyển trạng thái trong ngày.
- `captured`: `count`, `totalVnd` chuỗi, số `buyers` khác nhau, `byPlan` theo Plus/Pro với số đơn/tiền/người mua. Một người mua hai gói có thể xuất hiện trong cả hai nhóm, nên không cộng buyers theo gói để suy tổng người khác nhau.
- `daily`: ngày UTC+7, số đơn tạo, số đơn capture, `confirmedVnd`. Chỉ trả các ngày có dữ liệu khớp filter.
- `membershipSnapshot`: `asOf`, `scope:"GLOBAL_ACTIVE_VERIFIED_ACCOUNTS"`, số PLUS/PRO và tổng. Đây là gói còn hạn hiện tại, không phải thuê bao tự gia hạn hoặc số thành viên lịch sử ở ngày `to`.

### `GET /admin/payments/orders`

Query chung và `page` (mặc định 1, tối đa 100.000), `limit` (mặc định 25, tối đa 100). Trả `{ items, total, page, limit }`, sắp xếp ngày tạo mới nhất rồi ID giảm dần.

Mỗi item gồm ID đơn/người dùng; `customer` chỉ có ID, username, fullName, email, trạng thái hoặc null nếu không còn tài khoản; gói hiện tên/mã gốc/version/tên lúc mua; snapshot tiền, thời hạn, quota; invoice/payment code; transaction/reference; ngày tạo/capture/ngân hàng trả/hủy; `subscriptionExpiresAt` của **đơn đó**. Thời hạn đơn cũ không chứng minh gói hiện tại của tài khoản.

Không trả mật khẩu, Google ID, credential, idempotency key, full bank account hoặc raw transfer payload.

### `GET /admin/payments/orders/:id`

Trả `{ order, merchant, currentMembership, webhookSummary }`. ID không tồn tại trả 404.

- `order`: cùng hợp đồng một item danh sách.
- `merchant`: bankCode, bankGateway, accountLast4; không lộ đầy đủ tài khoản nhận.
- `currentMembership`: FREE/PLUS/PRO từ cùng resolver của billing, startsAt/expiresAt (null cho Free), `isCurrentPurchase`. Thông tin này mô tả chu kỳ; quyền truy cập còn phụ thuộc trạng thái tài khoản.
- `webhookSummary`: tổng receipt gắn với đơn và các nhóm outcome/count.

### `GET /admin/payments/orders/:id/receipts`

Chỉ nhận page/limit. Trả toàn bộ lịch sử receipt của đơn theo trang, **không dùng mặc định 30 ngày**, mới nhất trước. Đơn không tồn tại trả 404.

### `GET /admin/payments/receipts`

Query: from/to (quy tắc 90 ngày như trên), page/limit, `intentId` UUID, `outcome` chuỗi tối đa 100, `transactionId` chính xác tối đa 200, `unmatched="true"|"false"`. Các điều kiện kết hợp AND, không ghi đè nhau. Không áp dụng filter status/plan/q của danh sách đơn.

Trả `{ items, total, page, limit }`. Receipt chỉ gồm ID, intentId hoặc null, providerTransactionId, payloadHash, outcome, createdAt. Có thể xem webhook chưa gắn với đơn, ví dụ thiếu mã hoặc không tìm thấy intent.

Outcomes hiện có:

| Outcome                          | Ý nghĩa                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| CAPTURED                         | BE đã ghi nhận thanh toán                                  |
| DUPLICATE                        | Gửi lại giao dịch đã gắn với chính đơn đó                  |
| NOT_INCOMING                     | Không phải tiền vào                                        |
| PAYMENT_CODE_MISSING             | Thiếu mã thanh toán trong webhook                          |
| PAYMENT_INTENT_NOT_FOUND         | Không tìm thấy đơn từ mã                                   |
| ACCOUNT_MISMATCH                 | Ngân hàng/tài khoản nhận không khớp                        |
| AMOUNT_MISMATCH                  | Số tiền khác số tiền phải thanh toán, gồm cả thiếu hoặc dư |
| TRANSACTION_ALREADY_USED         | Giao dịch đã dùng cho đơn khác                             |
| PAYMENT_INTENT_ALREADY_SUCCEEDED | Đơn đã thành công, giao dịch mới không kích hoạt thêm      |
| PAYMENT_CANCELLED                | Đơn đã hủy                                                 |
| ACCOUNT_UNAVAILABLE              | Tài khoản không còn hoạt động hoặc chưa xác minh email     |

Receipt không lưu số tiền nhận sai, nội dung chuyển khoản hoặc payload gốc. FE chỉ có thể giải thích outcome; không phục dựng chi tiết chưa được lưu. Webhook HTTP 200 chỉ xác nhận đã xử lý delivery, không đồng nghĩa đơn đã paid.

### `GET /admin/payments/subscriptions`

Nhận page/limit, plan, userId; không nhận khoảng ngày/status/q của đơn. Trả `{ asOf, items, total, page, limit }`; mỗi item là đơn mới nhất đang xác định gói còn hạn của một tài khoản hoạt động đã xác minh. Cùng logic với snapshot, nhưng cho phép lọc plan/user riêng.

### `GET /admin/payments/export`

Nhận query chung của đơn. CSV UTF-8 BOM, đúng các đơn theo **ngày tạo**, tối đa 10.000; vượt trả 400 và yêu cầu thu hẹp filter, không cắt ngầm. Số tiền là chuỗi nguyên; text có nguy cơ công thức spreadsheet được escape. Không có full bank account/raw webhook. FE fetch Bearer rồi tải blob, không nhúng token trong URL.

Endpoint cũ **`GET /admin/payments/webhook-receipts`** tiếp tục giữ hợp đồng latest 50 sanitized receipts để tương thích client cũ.

## Triển khai và kiểm chứng

- Chỉ thêm index tra cứu vào hai collection đã có; Mongo autoIndex theo cơ chế hiện tại. Không sửa hoặc migrate nội dung intent/receipt cũ, không thêm env/package bắt buộc.
- Giữ nguyên cơ chế SePay code-only, kiểm tra tài khoản/số tiền, capture transaction, SSE và quota. Không có đường API Admin để gán paid hoặc hoàn tiền.
- Kiểm thử MongoDB/HTTP bao phủ mapping legacy, creation/capture boundaries, BigInt vượt 2^53, receipt trùng, gói mới nhất/hết hạn đúng thời điểm, tài khoản không hoạt động, filter/pagination, CSV quá giới hạn và phân quyền từ DB.
- Docker smoke dùng login thật với tài khoản fixture và webhook giả lập nội bộ, kiểm tra contract Zod FE qua API production build. Không chuyển tiền ngân hàng thật, không gọi inference AI trả phí.
- Build/typecheck không thay thế kiểm chứng tương tác trình duyệt. Số doanh thu ghi nhận cần đối soát với SePay và các khoản hoàn tiền/phí bên ngoài trước khi dùng làm báo cáo tài chính cuối cùng.
