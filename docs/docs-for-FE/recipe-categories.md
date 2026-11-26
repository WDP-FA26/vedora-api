# Danh mục công thức (admin)

Base URL: `/api/v1`. Chỉ admin. Gửi `Authorization: Bearer <accessToken>`.

Admin tự tạo, sửa, ẩn và xóa danh mục món. Mỗi danh mục gắn với một **nhóm chuẩn**
(`baseTag`, là một trong 9 loại `RecipeTag` cũ). Meal planner dựa vào nhóm chuẩn để
biết món hợp với bữa nào, nên danh mục mới vẫn được xếp đúng bữa.

Lần đầu BE khởi động với collection rỗng sẽ tự tạo 9 danh mục mặc định, trùng với 9 loại
món hiện tại (tên tiếng Việt và icon như FE đang hiển thị). Xóa một danh mục mặc định thì
nó không tự tạo lại.

> Phần này mới có CRUD cho admin. Công thức vẫn dùng `tag` như cũ; việc gắn công thức
> vào danh mục và lọc danh mục cho người dùng sẽ làm ở bước sau.

## API

| Method   | Endpoint                          | Thành công                    |
| -------- | --------------------------------- | ----------------------------- |
| `GET`    | `/admin/recipe-categories`        | 200 `{ items, meta }`, theo `sortOrder` tăng dần |
| `POST`   | `/admin/recipe-categories`        | 201 `RecipeCategory`          |
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
| `sortOrder`   | integer 0–9999 | Không | Nhỏ đứng trước, mặc định `0` |
| `hidden`      | boolean | Không | Ẩn khỏi người dùng nhưng không xóa, mặc định `false` |

`PUT` thay toàn bộ: trường không gửi sẽ về giá trị mặc định.

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
| 400  | `VALIDATION_FAILED` | Thiếu `name`/`baseTag`, `baseTag` hoặc `icon` không hợp lệ, có trường lạ |
| 401  | | Chưa đăng nhập |
| 403  | | Không phải admin |
| 404  | `NOT_FOUND` | Không có danh mục với `id` đó |
| 409  | `NAME_TAKEN` | Tên đã được danh mục khác dùng |
