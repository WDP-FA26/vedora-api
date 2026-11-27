# Quản lý giá gói và hạn mức AI

Admin quản lý cấu hình tại `/admin/subscription-plans` trên FE. API dùng prefix
`/api/v1`. Các endpoint bên dưới yêu cầu tài khoản ADMIN đang hoạt động; role
được kiểm tra từ DB. Response có `Cache-Control: private, no-store`.

## GET /admin/subscription-plans

Trả catalogue hiện tại, gồm giá/quota của Plus/Pro và quota Free:

```json
{
  "id": "9fd37843-83f6-48a4-ad66-012caec15136",
  "version": 0,
  "source": "ENV",
  "updatedAt": null,
  "updatedById": null,
  "planVersion": 2,
  "paymentsEnabled": true,
  "freeLimits": { "textLimit": 5, "imageLimit": 0 },
  "plans": [
    { "code": "PLUS", "name": "Plus", "priceVnd": "49000", "durationDays": 30, "textLimit": 300, "imageLimit": 10 },
    { "code": "PRO", "name": "Pro", "priceVnd": "99000", "durationDays": 30, "textLimit": 900, "imageLimit": 40 }
  ]
}
```

Đây là ví dụ theo mặc định code, không phải cấu hình production đã đo/đọc.
Khi chưa từng lưu, `source=ENV`, `version=0`; GET không tạo document. Giá và quota
được lấy đúng từ env hiện có. Sau lần lưu đầu, `source=DATABASE`, `version>=1`;
giá/quota DB được ưu tiên qua các lần khởi động. Lỗi đọc DB không bị che bằng
giá trị mặc định. Mỗi lần đọc lấy cấu hình chung, không cache riêng theo process.

`planVersion=2` là định dạng gói Plus/Pro hiện có; `version` là revision cấu hình
admin. Không dùng hai giá trị này thay cho nhau.

## PUT /admin/subscription-plans

Thay toàn bộ cấu hình giá/quota trong một lần ghi atomic:

```json
{
  "version": 0,
  "freeLimits": { "textLimit": 5, "imageLimit": 0 },
  "plans": [
    { "code": "PLUS", "priceVnd": 59000, "textLimit": 400, "imageLimit": 15 },
    { "code": "PRO", "priceVnd": 119000, "textLimit": 1200, "imageLimit": 50 }
  ]
}
```

- Body phải có đủ Free và đúng hai mã Plus/Pro, không lặp.
- Giá input là **number nguyên VND**, từ 1 đến 1.000.000.000; response giá vẫn
  là string như hợp đồng billing hiện tại. Không được sửa giá Free.
- Quota là số nguyên 0–1.000.000. Số 0 là không cấp lượt; không có giá trị
  "không giới hạn". Admin vẫn theo quy tắc miễn quota riêng hiện có.
- Không nhận tên gói, thời hạn, ngày hết hạn đơn hoặc đặc quyền tự khai báo.
- Lượt chữ dùng chung theo cơ chế AI usage hiện tại; lượt tạo ảnh tính riêng.
  Thoại AI hai chiều là đặc quyền cố định của Pro đang còn hạn, kể cả Pro mua
  trước khi có tính năng. Voice không trừ quota chữ và không có quota phút.
  API quản lý gói không chỉnh guest quota hoặc thời lượng kỹ thuật mỗi phiên.
- Gửi đúng `version` từ GET. Hai admin cùng sửa thì chỉ lần ghi đúng revision
  thành công, revision tăng 1. Revision cũ trả `409 SUBSCRIPTION_CATALOG_CONFLICT`.
  FE giữ bản nháp và cho admin chủ động tải lại; không tự ghi đè.
- Thao tác thành công/thất bại được nhật ký quản trị ghi dưới loại
  `SUBSCRIPTION_PLANS`. Không ghi toàn bộ request body vào nhật ký.

## Thời điểm có hiệu lực và QR đang chờ

**Plus/Pro:** cấu hình được đọc trong transaction tạo đơn và chép giá, thời hạn,
quota vào đơn. Sửa catalogue không chỉnh sửa bất kỳ đơn hay subscription cũ.

Ví dụ: người dùng tạo QR 49.000đ, 300 lượt chữ/10 ảnh; sau đó admin lưu giá
59.000đ, 400 lượt chữ/15 ảnh. QR cũ vẫn yêu cầu 49.000đ, giữ hạn thanh toán ban
đầu, và khi thanh toán hợp lệ sẽ cấp 300/10 theo snapshot. Webhook so sánh tiền
với **đơn**, không so với catalogue mới. Trả tiền theo giá mới cho QR cũ là sai
số tiền và không tự kích hoạt gói.

Retry cùng Idempotency-Key vẫn trả đơn cũ. Nếu tạo yêu cầu khác trong khi còn
đơn chờ có hợp đồng khác, API trả `PENDING_PAYMENT_CONFLICT`; người dùng tiếp tục
đơn cũ hoặc hủy nó rồi tạo đơn mới. Không tự hủy/đổi số tiền của QR đang dùng.

Gói đang có hiệu lực giữ snapshot tới hết chu kỳ; quy tắc mua gói khác bắt đầu
chu kỳ mới vẫn giữ nguyên. Các đơn legacy thiếu snapshot quota tiếp tục dùng
quota lịch sử cố định, không dùng cấu hình admin mới.

**Free:** quota mới có hiệu lực ngay nhưng giữ nguyên period key và số lượt đã
dùng trong ngày. Giảm quota xuống dưới lượng đã dùng sẽ có remaining=0; tăng
quota chỉ cấp phần chênh lệch. Không đặt lại usage khi lưu.

## Tích hợp và triển khai

- `GET /billing/plans` giữ nguyên shape và lấy giá/quota từ cùng catalogue;
  không lộ revision/actor metadata cho người dùng.
- Không cần env mới hoặc seed. Collection `subscription_catalogs` được Mongoose
  khai báo; lần lưu đầu tạo document duy nhất. Env cũ là cấu hình ban đầu;
  `BILLING_DURATION_DAYS` và cấu hình SePay vẫn hoạt động theo cơ chế hiện có.
- Triển khai BE trước FE. FE thêm menu **Hệ thống → Gói đăng ký**, bảng chung và
  sheet chỉnh sửa; sau lưu cập nhật cache quản lý và làm mới billing trong tab.
- Cấu hình quota/giá trong DB chỉ đổi bởi admin lưu; thay env rồi restart không
  ghi đè cấu hình đã lưu. Không có endpoint xóa hoặc reset tự động.

## Kiểm tra

HTTP test với Mongo thật trong `test/e2e/admin-subscription-plans.e2e-spec.ts`
bao phủ phân quyền, validation, lưu/version, catalogue billing, QR chờ, webhook
sai/đúng tiền, quyền lợi gói cũ/legacy và Free usage. Các regression payment và
subscription tiếp tục dùng DB riêng, không gọi SePay hoặc provider AI thật.
