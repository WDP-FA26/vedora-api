# Lưu công thức yêu thích

Base URL `/api/v1`. Tất cả API dưới đây yêu cầu Bearer token và chỉ thao tác với
người gọi. Không nhận `userId` hoặc trạng thái do client đặt. Không có public count.

| Method | Endpoint | Kết quả HTTP 200 |
| --- | --- | --- |
| PUT | `/recipes/:id/favorite` | `{ recipeId, isFavorite: true }` |
| DELETE | `/recipes/:id/favorite` | `{ recipeId, isFavorite: false }` |
| GET | `/recipes/favorites?page=1&limit=20` | `{ items, meta }` |

PUT/DELETE không cần body (có thể gửi `{}`); field lạ trong body trả 400. Lưu lại
không tạo trùng và không đổi thời gian lưu ban đầu. Bỏ lưu lặp không lỗi. Bỏ rồi
lưu lại tạo thời gian mới. Danh sách sắp `savedAt DESC, recipeId DESC`, dùng chuẩn
page/limit chung (limit 1–50), không nhận sort hoặc owner tùy ý. Trang vượt phạm
vi trả items rỗng với totalItems thực tế.

Mỗi item là dữ liệu catalog hiện tại (id/title/image/servings/time/conflicts/post…)
và thêm `isFavorite: true`, `savedAt` UTC ISO 8601. Không trả userId hoặc email.
Nguồn Post chưa PUBLISHED được trả `post=null`, giống catalog công khai.

`GET /recipes` và `GET /recipes/:id` bổ sung `isFavorite`: token hợp lệ nhận
trạng thái của chính mình; guest luôn false. Mọi response catalog/detail có token
và mọi response favorites dùng `Cache-Control: private, no-store`. Catalog/detail
có `Vary: Authorization`; FE cache theo account, xóa khi logout/đổi account.

Sau PUT/DELETE thành công, dùng response cập nhật nút lưu và invalidate danh sách
đã lưu + catalog/detail của account. Favorites không tự thêm món vào thực đơn;
vẫn gọi preview/lưu thực đơn như trước, với kiểm tra hồ sơ ăn uống hiện tại.

| HTTP | Trường hợp |
| --- | --- |
| 400 | UUID/query/body sai, owner/field không hỗ trợ |
| 401 | Thiếu/sai token hoặc account không còn |
| 404 | Recipe không tồn tại, kể cả PUT/DELETE |
| 409 | `FAVORITE_CONFLICT`: tải lại trước khi thử lại |

Migration additive `20261019140000_recipe_favorites` tạo PK user/recipe và FK
cascade theo cơ chế xóa cứng hiện tại. Không seed lại. Mỗi mutation khóa account
rồi Recipe; list/catalog đọc dữ liệu + flag/count trong một RepeatableRead snapshot.
Repo chưa có Hidden/approved revision/safety hold; khi các trạng thái đó được
triển khai cần nối cùng public gate vào catalog và danh sách saved. Không suy ra
món phù hợp cá nhân chỉ vì đã được lưu.

Kiểm tra:

```powershell
npm test
npm run test:e2e
$env:TEST_DATABASE_URL = "postgresql://postgres:password@localhost:5432/vedora_test"
npm run test:db
npm run build
npm run lint
```
