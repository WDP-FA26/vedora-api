# Phân quyền người dùng — hợp đồng API cho frontend

Cập nhật: 19/10/2026. Base URL mặc định khi chạy local:
`http://localhost:4000/api/v1`; frontend lấy từ `NEXT_PUBLIC_API_URL`.

Account hiện có thêm `status` và `accountVersion`. Chỉ account ACTIVE được dùng
API có xác thực. Xem [khóa/mở khóa tài khoản](account-suspension.md) cho status,
reason, version conflict và bảo vệ ADMIN ACTIVE cuối cùng.

## Vai trò

| Giá trị `role` | Quyền quản lý tài khoản                              |
| -------------- | ---------------------------------------------------- |
| `USER`         | Xem, sửa, xóa tài khoản của mình                     |
| `ADMIN`        | Tạo, liệt kê, xem, sửa, xóa tài khoản và đổi vai trò |

Đăng ký bằng mật khẩu hoặc Google tạo tài khoản `USER`. CRUD tạo tài khoản của
admin cũng tạo `USER`; muốn cấp `ADMIN` phải gọi API đổi vai trò riêng.

Vai trò quản trị độc lập với xác minh email và huy hiệu đầu bếp. Backend chưa có
vai trò đầu bếp hoặc hệ thống xét duyệt huy hiệu.

## Trường `role` trong response

User object có thêm `role: "USER" | "ADMIN"`. Ví dụ `GET /auth/me`:

```json
{
  "id": "4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2",
  "username": "vedora.user",
  "fullName": "Vedora User",
  "email": "hello@vedora.vn",
  "role": "USER",
  "status": "ACTIVE",
  "accountVersion": 0,
  "createdAt": "2026-09-28T00:00:00.000Z",
  "updatedAt": "2026-09-28T00:00:00.000Z"
}
```

Các response sau cũng có trường này:

- `user` trong response thành công của `POST /auth/login`, `POST /auth/verify-email`,
  `POST /auth/google`, `POST /auth/refresh`.
- Các user object trả về từ `/users`, gồm cả API đổi vai trò.

`POST /auth/register` vẫn chỉ trả `{ "email": "..." }`, chưa trả token hay user.
Author object trong response bài đăng vẫn chỉ gồm `id`, `username`, `fullName`.

FE cần bổ sung `role` vào `CurrentUser` và schema parse user nếu có. Các cookie
access/refresh token và luồng đăng nhập hiện tại tiếp tục sử dụng như trước.

## Bảng quyền API

Tất cả endpoint trong bảng yêu cầu `Authorization: Bearer <accessToken>`.
`:id` phải là UUID của tài khoản được thao tác.

| Method | Endpoint          | USER                            | ADMIN              |
| ------ | ----------------- | ------------------------------- | ------------------ |
| GET    | `/auth/me`        | Tài khoản hiện tại              | Tài khoản hiện tại |
| POST   | `/users`          | 403                             | Được phép          |
| GET    | `/users`          | 403                             | Được phép          |
| GET    | `/users/:id`      | Chỉ khi `:id === user.id`       | Bất kỳ tài khoản   |
| PATCH  | `/users/:id`      | Chỉ tài khoản của mình          | Bất kỳ tài khoản   |
| DELETE | `/users/:id`      | Chỉ tài khoản của mình          | Bất kỳ tài khoản   |
| PATCH  | `/users/:id/role` | 403, kể cả đổi vai trò của mình | Bất kỳ tài khoản   |

GET/PATCH thành công trả `200`, POST tạo tài khoản trả `201`, DELETE trả `204`
không có body. Tài khoản không tồn tại trả `404` khi người gọi có quyền thao tác;
USER truy cập ID khác trả `403` trước khi tra cứu tài khoản đó.

Profile update vẫn chỉ nhận `username`, `fullName`, `email`. Gửi thêm `role` vào
đăng ký, tạo tài khoản hoặc sửa profile sẽ bị từ chối `400`, kể cả người gọi là admin.

API bài đăng và media vẫn giữ quy tắc sở hữu hiện tại: chỉ tác giả xóa bài,
chỉ chủ sở hữu xem/discard upload. Vai trò admin trong thay đổi này phục vụ quản lý
tài khoản, chưa thêm API kiểm duyệt nội dung.

## Đổi vai trò

```http
PATCH /api/v1/users/4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2/role
Authorization: Bearer <adminAccessToken>
Content-Type: application/json

{"role":"ADMIN","expectedVersion":0,"reason":"Cấp quyền quản trị"}
```

Body bắt buộc có `role` (`USER` hoặc `ADMIN`), `expectedVersion` lấy từ
`accountVersion` hiện tại và `reason` 1–500 ký tự sau trim. Response `200` là user
object với vai trò/version mới. Hạ quyền gửi `role: "USER"` cùng hai field trên.
Không cho hạ quyền hoặc xóa ADMIN ACTIVE cuối cùng; trả `409 LAST_ACTIVE_ADMIN`.
Version cũ trả `409 ACCOUNT_VERSION_CONFLICT`; FE tải lại trước khi xác nhận lại.

API cho phép admin đổi vai trò của chính mình và không bảo vệ admin cuối cùng.
FE nên yêu cầu xác nhận cho thao tác hạ quyền hoặc xóa tài khoản admin đang dùng;
sau khi tự hạ quyền, chuyển về trang người dùng và tải lại session.

## Thay đổi quyền và phiên đăng nhập

Backend kiểm tra tài khoản và vai trò hiện tại trong database mỗi request đã
xác thực. FE không lấy quyền từ việc giải mã JWT; token hiện tại không có role
claim. JWT đã cấp trước thay đổi này vẫn dùng được nếu còn hạn và tài khoản tồn tại.

- Hạ quyền `ADMIN` → `USER`: request quản trị tiếp theo bị từ chối `403`, không
  cần chờ access token hết hạn hoặc đăng nhập lại.
- Nâng quyền `USER` → `ADMIN`: token hiện tại được dùng cho request quản trị tiếp theo.
- Xóa tài khoản: JWT cũ bị từ chối `401` trên các API cần đăng nhập.
- Sau khi đổi vai trò, FE cập nhật cache user/danh sách; tài khoản bị đổi quyền
  cần tải lại `/auth/me` để giao diện phản ánh quyền mới.

## Xử lý lỗi trên FE

| HTTP status | Ý nghĩa trong các API quản lý tài khoản                                | Xử lý                                                                                                |
| ----------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `400`       | UUID/body không hợp lệ, role không hợp lệ hoặc field không được hỗ trợ | Hiển thị lỗi dữ liệu; không tự retry                                                                 |
| `401`       | Thiếu JWT, JWT sai/hết hạn hoặc tài khoản đã bị xóa                    | Dùng luồng refresh hiện có; nếu phiên bị từ chối thì đưa về đăng nhập                                |
| `403`       | Đã xác thực nhưng không có quyền                                       | Thông báo không đủ quyền, tải lại `/auth/me`, cập nhật giao diện; không coi là lỗi cần refresh token |
| `404`       | Tài khoản mục tiêu không tồn tại                                       | Thông báo và cập nhật danh sách                                                                      |
| `409`       | Username/email đã được dùng                                            | Hiển thị lỗi ở field tương ứng                                                                       |

Ví dụ lỗi thiếu quyền quản trị:

```json
{
  "statusCode": 403,
  "code": "FORBIDDEN",
  "message": "Insufficient permissions"
}
```

Ví dụ USER thao tác tài khoản khác:

```json
{
  "statusCode": 403,
  "code": "FORBIDDEN",
  "message": "You can only access your own account"
}
```

Mọi lỗi dùng cùng cấu trúc `{ statusCode, code, message, details? }`, xem
[errors.md](errors.md). Không áp dụng quy tắc xử lý `403` quản trị cho
`POST /auth/login`: `EMAIL_NOT_VERIFIED` (kèm `details.email`) vẫn thuộc luồng xác minh
email hiện tại.

## Các việc FE cần tích hợp

1. Thêm `role` vào kiểu user; dùng `/auth/me` làm nguồn quyền cho giao diện.
2. Chặn trang/công cụ quản trị khi chưa đăng nhập hoặc `user.role !== "ADMIN"`.
   `/admin` hiện mới là khung giao diện và chưa được bảo vệ theo role.
3. Chỉ hiện chức năng quản lý tài khoản và đổi vai trò cho admin. Người dùng thường
   chỉ có thao tác tài khoản của mình.
4. Khi đổi vai trò thành công, cập nhật cache của user và danh sách; xử lý `403`
   nếu quyền thay đổi trong lúc trang đang mở.
5. Khi xóa tài khoản của mình thành công, xóa cookie phiên qua luồng logout hiện có
   và chuyển về đăng nhập.

Việc ẩn menu/chặn trang giúp giao diện đúng quyền; API luôn tự kiểm tra quyền.
Thay đổi backend này chưa sửa mã frontend.

## Chuẩn bị backend trước khi tích hợp

Backend cần áp dụng migration `20260928000000_add_user_roles` trước khi chạy bản
code mới. Tài khoản có trước migration mặc định là `USER`; không tự cấp `ADMIN`
dựa vào tên hoặc email. Để tạo/nâng quyền tài khoản bootstrap `vedora.admin`, backend
chạy seed với `SEED_USER_PASSWORD` đã cấu hình theo hướng dẫn trong README.
Khi nâng quyền tài khoản seed cũ còn là `USER`, mật khẩu cấu hình phải khớp mật
khẩu tài khoản đó; seed từ chối cấp admin chỉ dựa vào tên/email trùng khớp.
