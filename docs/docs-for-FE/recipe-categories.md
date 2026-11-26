# Danh mục công thức

Base URL: `/api/v1`. Các route `/admin/...` chỉ cho admin và cần `Authorization: Bearer <accessToken>`.
`GET /recipe-categories` công khai, không cần đăng nhập.

Admin tự tạo, sửa, ẩn và xóa danh mục món. Mỗi danh mục gắn với một **nhóm chuẩn**
(`baseTag`, là một trong 9 loại `RecipeTag` cũ). Meal planner dựa vào nhóm chuẩn để
biết món hợp với bữa nào, nên danh mục mới vẫn được xếp đúng bữa.

Lần đầu BE khởi động với collection rỗng sẽ tự tạo 9 danh mục mặc định, trùng với 9 loại
món hiện tại (tên tiếng Việt và icon như FE đang hiển thị). Xóa một danh mục mặc định thì
nó không tự tạo lại.

Công thức không lưu id danh mục. Một công thức thuộc danh mục khi `tag` của nó bằng
`baseTag` của danh mục. Vì vậy hai danh mục có cùng `baseTag` sẽ hiện cùng một tập công thức.

## Người dùng duyệt theo danh mục

| Method | Endpoint | Thành công |
| ------ | -------- | ---------- |
| `GET`  | `/recipe-categories` | 200 `{ items, meta }`, chỉ danh mục **không ẩn**, theo `sortOrder` tăng dần |
| `GET`  | `/recipes?tag=<baseTag>` | 200 `{ items, meta }`, chỉ công thức có `tag` đó |

- `GET /recipe-categories` dùng `page`/`limit` (`limit` tối đa 50), trả cùng dạng `RecipeCategory` bên dưới.
- `tag` của `GET /recipes` dùng chung được với `q`, `maxMinutes` và `suitableForMe`. Công thức
  chưa có `tag` không hiện khi lọc, nhưng vẫn hiện khi không gửi `tag` (chip "Tất cả").
  `tag` sai giá trị, rỗng hoặc gửi hai lần thì trả `400 VALIDATION_FAILED`.
- Chip ở FE: `Tất cả` + một chip cho mỗi danh mục. Bấm chip thì gọi `GET /recipes?tag=<baseTag>`.

## API cho admin

| Method   | Endpoint                          | Thành công                    |
| -------- | --------------------------------- | ----------------------------- |
| `GET`    | `/admin/recipe-categories`        | 200 `{ items, meta }`, theo `sortOrder` tăng dần |
| `POST`   | `/admin/recipe-categories`        | 201 `RecipeCategory`, xếp cuối danh sách |
| `PUT`    | `/admin/recipe-categories/order`  | 204, đặt lại thứ tự toàn bộ    |
| `PUT`    | `/admin/recipe-categories/:id`    | 200 `RecipeCategory` (thay toàn bộ) |
| `DELETE` | `/admin/recipe-categories/:id`    | 204                           |

`GET` dùng `page`/`limit` như các danh sách khác (`limit` tối đa 50).

### Body của `POST` / `PUT`

| Trường        | Kiểu | Bắt buộc | Ghi chú |
| ------------- | ---- | -------- | ------- |
| `name`        | string | Có | Được trim, 1 tới `INGREDIENT_NAME_MAX_LENGTH` ký tự, không trùng |
| `description` | string | Không | Chuỗi rỗng lưu thành `null` |
| `baseTag`     | `SOUP` \| `SALAD` \| `RICE` \| `NOODLES` \| `STIR_FRY` \| `BREAD` \| `DESSERT` \| `DRINK` \| `SNACK` | Có | Nhóm chuẩn cho meal planner |
| `icon`        | `SOUP` \| `SALAD` \| `POT` \| `WHEAT` \| `FLAME` \| `SANDWICH` \| `CAKE` \| `COFFEE` \| `COOKIE` \| `UTENSILS` | Không | Mặc định `UTENSILS` |
| `hidden`      | boolean | Không | Ẩn khỏi người dùng nhưng không xóa, mặc định `false` |

`PUT /:id` thay toàn bộ: trường không gửi sẽ về giá trị mặc định. Thứ tự (`sortOrder`)
không sửa ở đây mà qua `PUT /order`.

### Sắp xếp: `PUT /admin/recipe-categories/order`

```json
{ "ids": ["<id đứng đầu>", "<id thứ hai>", "…"] }
```

Gửi **tất cả** id danh mục theo thứ tự mới. BE đánh lại `sortOrder` thành 10, 20, 30…
trong một transaction. Thiếu, thừa hoặc lặp id thì trả `400 ORDER_MISMATCH` (hoặc
`VALIDATION_FAILED` nếu lặp id). Nút mũi tên lên/xuống ở FE chỉ cần đổi chỗ hai id kề
nhau rồi gửi cả danh sách.

### `RecipeCategory`

```json
{
  "id": "6f1c…",
  "name": "Món canh, súp",
  "description": null,
  "baseTag": "SOUP",
  "icon": "SOUP",
  "sortOrder": 10,
  "hidden": false,
  "createdAt": "2026-11-26T10:00:00.000Z"
}
```

## Lỗi

| HTTP | `code` | Khi nào |
| ---- | ------ | ------- |
| 400  | `VALIDATION_FAILED` | Thiếu `name`/`baseTag`, `baseTag` hoặc `icon` không hợp lệ, có trường lạ (kể cả `sortOrder`) |
| 400  | `ORDER_MISMATCH` | `PUT /order` không liệt kê đúng toàn bộ danh mục |
| 401  | | Chưa đăng nhập |
| 403  | | Không phải admin |
| 404  | `NOT_FOUND` | Không có danh mục với `id` đó |
| 409  | `NAME_TAKEN` | Tên đã được danh mục khác dùng |
