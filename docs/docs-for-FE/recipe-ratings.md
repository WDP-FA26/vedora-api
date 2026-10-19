# Đánh giá công thức từ 1–5 sao

Base URL: `/api/v1`. Một người dùng có một điểm hiện tại trên mỗi công thức.
Đổi từ 4 sang 5 cập nhật điểm đó, không thêm một lượt đánh giá. Gửi lại cùng
điểm hoặc xóa lại không tăng/giảm count lần nữa.

## API

| Method | Endpoint | Xác thực | Kết quả |
| --- | --- | --- | --- |
| GET | `/recipes/:id/ratings/summary` | Public; token đã gửi phải hợp lệ | Tổng và trung bình, không có danh tính người chấm |
| GET | `/recipes/:id/rating` | Bearer | Tổng, trung bình và điểm của người gọi |
| PUT | `/recipes/:id/rating` | Bearer, email đã xác minh | Đặt/cập nhật điểm của người gọi |
| DELETE | `/recipes/:id/rating` | Bearer | Gỡ điểm của người gọi, trả tổng mới |

PUT nhận duy nhất body:

```json
{ "value": 4 }
```

`value` là số nguyên từ 1 đến 5. Không nhận chuỗi `"4"`, số thập phân, null,
`userId`, `ratingCount` hoặc `averageRating`. Backend lấy người chấm từ token;
không có API chọn user khác, kể cả khi caller là Admin. Tác giả công thức
(`createdById`) không được tự đánh giá; Admin cũng áp dụng quy tắc này.

Response public HTTP 200:

```json
{
  "recipeId": "d1a2d3e4-0000-4000-8000-000000000001",
  "ratingCount": 2,
  "averageRating": 4.5
}
```

GET riêng, PUT và DELETE trả thêm `myRating: number | null`, với
`Cache-Control: private, no-store`. Chưa chấm hoặc đã gỡ thì `myRating=null`.
Không còn điểm hợp lệ thì `ratingCount=0`, `averageRating=null`; FE nên hiển thị
“Chưa có đánh giá”, không biến null thành 0 sao.

Điểm trung bình là sum/count, làm tròn một chữ số thập phân. Response không trả
tên, email, ID người chấm hay danh sách rating của người khác. Các API catalog
hiện có giữ response cũ; FE lấy summary qua endpoint mới khi mở chi tiết món.

## Đồng thời và dữ liệu hiện tại

- DB có khóa unique `(recipe_id, user_id)`, FK và CHECK `value BETWEEN 1 AND 5`.
- PUT/DELETE kiểm tra account, khóa Recipe và ghi/đọc summary trong cùng
  transaction. Request trên cùng Recipe được xử lý tuần tự; response của mỗi
  request phản ánh thao tác đó. Request được xử lý sau quyết định điểm cuối cùng.
- Tổng được tính từ rating hiện tại của các user có `emailVerifiedAt != null`,
  không dùng aggregate do client gửi hoặc bộ đếm ghi tăng/giảm riêng.
- Quyền public của Recipe dùng cùng kho công thức Admin hiện tại. Repo chưa có
  `AccountStatus` Suspend/Reactivate, safety hold hay approved revision; tính năng
  này không bổ sung các trạng thái đó. Khi chúng được triển khai, cần nối account
  và content gate mới vào cả đọc, aggregate và ghi rating trước nghiệm thu đầy đủ
  REQ-INT-02 theo SRS.
- Với cơ chế xóa cứng hiện tại, xóa account/Recipe dọn rating qua FK; summary
  được tính lại khi đọc. Recipe không tồn tại trả 404, không trả summary 0 giả.
- DELETE chỉ gỡ điểm của mình, được phép cả khi email hiện chưa xác minh, để
  người dùng luôn có thể rút đánh giá. PUT vẫn yêu cầu email đã xác minh.

## Lỗi và cách tích hợp

| HTTP | Trường hợp |
| --- | --- |
| 400 | UUID/body sai, điểm không phải integer 1–5, field không hỗ trợ |
| 401 | Thiếu token trên API riêng, token sai/hết hạn hoặc account không còn |
| 403 | `SELF_RATING_NOT_ALLOWED` hoặc `EMAIL_NOT_VERIFIED` |
| 404 | Không tồn tại Recipe |
| 409 | `RATING_CONFLICT`: tải lại điểm/summary trước khi thử lại |

Khi mở chi tiết, guest gọi summary; người đăng nhập gọi GET `/rating` để có cả
điểm hiện tại. Chọn sao gọi PUT, gỡ sao gọi DELETE. Dùng response 200 cập nhật
giao diện; khi 4xx/5xx giữ trạng thái trước và hiển thị lỗi. Cache dữ liệu riêng
theo account + Recipe, xóa cache khi logout/đổi account.

## Migration và kiểm tra

Migration additive: `20261019130000_recipe_ratings`. Cần chạy migration trước
khi đưa code mới phục vụ request; không cần seed lại công thức/user.

```powershell
npm run prisma:migrate:deploy
npm run prisma:generate
npm run build
npm run test:e2e -- test/recipe-ratings.e2e-spec.ts
```

PostgreSQL integration tests dùng database test riêng, mỗi suite tạo schema
ngẫu nhiên rồi dọn schema đó:

```powershell
$env:TEST_DATABASE_URL = "postgresql://postgres:password@localhost:5432/vedora_test"
npm run test:db -- test/recipe-ratings.db-spec.ts
```

Các ca gồm update/retry không tăng count, privacy giữa account/Admin, self-rating,
thay đổi eligibility email, CHECK/FK/unique, 20 PUT đồng thời cùng user,
PUT/DELETE đồng thời, nhiều người chấm cùng lúc và Recipe bị xóa khi đang chấm.
