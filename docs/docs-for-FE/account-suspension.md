# Khóa/mở khóa tài khoản và bảo vệ admin cuối cùng

Base URL `/api/v1`. Các endpoint quản trị dùng Bearer của ADMIN đang ACTIVE.
Chỉ bổ sung kiểm tra trạng thái tài khoản; JWT giữ claims hiện tại, không thêm
Redis, blacklist, session hay authEpoch theo quyết định của requester.

## Danh sách và dữ liệu tài khoản

`GET /users?page=1&limit=20&q=member&status=SUSPENDED`

- `q` tùy chọn, tối đa 100 ký tự, trim, tìm không phân biệt hoa/thường trong
  username/fullName/email. `status` tùy chọn: PENDING_EMAIL/ACTIVE/SUSPENDED/DELETED.
- Response `{ items, meta }` như phân trang hiện tại; lọc và count cùng snapshot.
- Dữ liệu `/users`, `/users/:id`, `/auth/me` và auth response thêm `status` và
  `accountVersion` (integer bắt đầu từ 0). Đây là dữ liệu admin/chính chủ; public
  profile không thêm email hoặc trạng thái tài khoản.
- Không nhận `include`, userId, sort hay quan hệ chat/dietary/meal-plan tùy ý.

## Suspend/Reactivate

`PATCH /users/:id/status`

```json
{
  "status": "SUSPENDED",
  "expectedVersion": 0,
  "reason": "Tạm khóa sau khi xem xét vi phạm"
}
```

Mở khóa gửi `status: "ACTIVE"`. Chỉ cho phép ACTIVE ↔ SUSPENDED. PENDING_EMAIL
phải xác minh email, không kích hoạt bằng nút quản trị. Request mở khóa tài khoản
chưa xác minh email trả 409. `reason` trim, bắt buộc 1–500 ký tự;
`expectedVersion` là số nguyên 0–2147483646, không nhận chuỗi số. Field lạ trả 400.

HTTP 200 trả account cập nhật, tăng `accountVersion` một lần. Gửi lại cùng trạng
thái và version hiện tại là no-op, không tăng version/ghi audit. Gửi lại request
cũ sau một thay đổi vẫn trả version conflict; không tự retry mù.

## Role và bảo vệ admin cuối cùng

`PATCH /users/:id/role` nay **bắt buộc thêm expectedVersion và reason**:

```json
{
  "role": "USER",
  "expectedVersion": 2,
  "reason": "Điều chỉnh quyền quản trị"
}
```

Role/status update và `DELETE /users/:id` dùng cùng transaction gate. Không cho
khóa, hạ quyền hay xóa ADMIN ACTIVE cuối cùng, kể cả hai request đồng thời trên
hai admin khác nhau. Admin tự hạ quyền được khi còn admin ACTIVE khác. Admin
SUSPENDED hoặc PENDING_EMAIL không được tính là admin thay thế.

Quyền người thao tác được đọc lại sau khi khóa, tránh token/quyền đọc trước đó
vượt qua một lần hạ quyền/khóa đã commit. Không có bulk endpoint bypass gate.
Thay đổi và audit cùng transaction; audit lỗi thì rollback cả thay đổi.
Audit lưu actor, target, hành động, lý do, role/status trước và sau, version,
timestamp. Audit xóa tài khoản giữ lại scalar IDs sau khi tài khoản bị xóa cứng;
không thêm API công khai đọc audit. DELETE giữ request contract hiện tại và ghi
lý do hệ thống `Account deletion requested`.

## Tác động khi khóa

- Password login, Google login/linking, refresh và request có Bearer bị từ chối
  khi account SUSPENDED. Guard kiểm tra status hiện tại cùng truy vấn lấy role.
- HTTP 401 có `code: "ACCOUNT_SUSPENDED"`; PENDING_EMAIL/DELETED nhận
  `ACCOUNT_NOT_ACTIVE` khi dùng token. Password login chưa xác minh email vẫn
  giữ luồng `403 EMAIL_NOT_VERIFIED` hiện tại.
- FE xóa trạng thái đăng nhập/cache riêng và hiển thị tài khoản bị khóa; không
  refresh lặp vô hạn. Public endpoint không có token vẫn có thể dùng như guest.
- Refresh-token issuance/rotation khóa account và kiểm tra ACTIVE trong cùng
  transaction, nên không ghi token mới sau khi Suspend đã commit.
- Password reset không mở khóa tài khoản. Xác minh/reset của PENDING_EMAIL có
  thể chuyển sang ACTIVE; Google có thể xác minh pending account, không bỏ qua
  trạng thái SUSPENDED.
- Không blacklist/revoke token khi Suspend: **sau Reactivate, access/refresh token
  cũ còn hạn và chưa bị revoke/rotate bởi luồng khác có thể dùng lại**.
- Guard chặn request đi qua bước xác thực sau khi khóa commit. Không hủy request
  hay AI stream đã qua xác thực. Gate ghi nội dung ở từng module và ẩn nội dung
  của tác giả bị khóa chưa nằm trong thay đổi này; không tuyên bố đã hoàn tất
  toàn bộ REQ-AUTH-02/REQ-VIS của SRS.

## Lỗi FE cần xử lý

| HTTP | Code/trường hợp                                       | Hành vi                                         |
| ---- | ----------------------------------------------------- | ----------------------------------------------- |
| 400  | UUID/body/query sai                                   | Hiển thị lỗi input                              |
| 401  | ACCOUNT_SUSPENDED / ACCOUNT_NOT_ACTIVE hoặc token sai | Xử lý auth, không tự lặp refresh                |
| 403  | Người dùng không có quyền ADMIN                       | Ẩn/chặn chức năng quản trị                      |
| 404  | Account không tồn tại                                 | Tải lại danh sách                               |
| 409  | ACCOUNT_VERSION_CONFLICT                              | Reload account, yêu cầu người dùng xác nhận lại |
| 409  | LAST_ACTIVE_ADMIN                                     | Giải thích cần giữ ít nhất một admin ACTIVE     |
| 409  | INVALID_ACCOUNT_TRANSITION                            | Không dùng nút này để xác minh email            |

## Migration và kiểm thử

Migration `20261019170000_account_suspension` thêm status/account_version và bảng
audit. Account cũ có email_verified_at chuyển ACTIVE, còn lại PENDING_EMAIL.
Account mới mặc định PENDING_EMAIL; Google/seed admin mới tạo ACTIVE. Seed không
tự mở khóa admin đã bị Suspend. DELETED được dành cho lifecycle/audit; endpoint
xóa hiện tại vẫn xóa cứng, không đổi sang soft delete trong tính năng này.

```powershell
npm run prisma:migrate:deploy
npm run prisma:generate
npm run build
npm run lint
npm test
npm run test:e2e
$env:TEST_DATABASE_URL = "postgresql://user:password@localhost:5432/vedora_test"
npm run test:db
```

FE task Open đi kèm API mới; BE và FE cần deploy tương thích vì role update đã
thêm hai field bắt buộc. Việc implementation hoàn tất không có nghĩa đã merge
hoặc deploy môi trường dùng chung.
