# Kho công thức và chọn món vào thực đơn

Base URL: `/api/v1`. Kho công thức do admin quản lý; người dùng và guest được đọc.
Nhánh dietary-profile bổ sung migration và điều kiện phù hợp theo hồ sơ.
Đọc [Hồ sơ chế độ ăn và dị ứng](dietary-profile.md) để áp dụng hợp đồng mới;
Swagger mô tả đầy đủ request/response tại `/docs`.

## API

| Method | Endpoint             | Đăng nhập                                | Kết quả                                       |
| ------ | -------------------- | ---------------------------------------- | --------------------------------------------- |
| GET    | `/recipes`           | Không; bắt buộc nếu `suitableForMe=true` | `{ items, meta }`                             |
| GET    | `/recipes/:id`       | Không                                    | Chi tiết công thức                            |
| GET    | `/meal-plan`         | Có                                       | Thực đơn đang lưu, đủ 7 ngày và 4 phần/ngày   |
| POST   | `/meal-plan/preview` | Có                                       | Đề xuất, nội dung cũ và các vấn đề; không lưu |
| PUT    | `/meal-plan/days`    | Có                                       | Lưu các ngày được gửi và trả thực đơn mới     |

Gửi `Authorization: Bearer <accessToken>` khi cần đăng nhập. Trên API đọc công
thức, nếu gửi token sai/hết hạn hoặc tài khoản đã bị xóa, backend trả `401`;
không tự chuyển sang đọc ẩn danh. Các thao tác tạo/sửa/xóa công thức vẫn thuộc
`/admin/recipes` và chỉ admin được phép.

## Danh sách, tìm kiếm và bộ lọc

```http
GET /api/v1/recipes?q=đậu%20phụ&maxMinutes=30&page=1&limit=20
GET /api/v1/recipes?suitableForMe=true&maxMinutes=30
Authorization: Bearer <accessToken>
```

| Query           | Mặc định  | Quy tắc                                                                                                              |
| --------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `q`             | Không lọc | 1–100 ký tự sau trim; tìm chuỗi con không phân biệt hoa/thường trong tên món, mô tả, tên và tên khác của nguyên liệu |
| `maxMinutes`    | Không lọc | Số nguyên 0–2880, giới hạn tổng phút chuẩn bị + nấu                                                                  |
| `suitableForMe` | `false`   | Chỉ nhận `true`/`false`; `true` cần đăng nhập và dùng hồ sơ của người gọi                                            |
| `veganOnly` | `false` | Chỉ công thức có toàn bộ thành phần đã xác minh Vegan |
| `page`          | `1`       | Số nguyên 1–1000000                                                                                                  |
| `limit`         | `20`      | Số nguyên 1–50                                                                                                       |

Tìm kiếm hiện giữ nguyên dấu tiếng Việt; `%`, `_`, dấu nháy và dấu gạch chéo
được coi là văn bản. Query rỗng, tham số lặp hoặc field không khai báo trả `400`.
Khi thay bộ lọc, quay về trang 1.

Nếu chỉ biết một thời gian, tổng dùng thời gian đó; nếu cả hai đều `null`,
`totalMinutes` là `null` và món bị loại khi dùng `maxMinutes`. Danh sách sắp xếp
theo `updatedAt DESC`, rồi `id DESC`. Bộ lọc được áp dụng **trước phân trang và
đếm**; trang vượt tổng số trang trả danh sách rỗng với tổng thực tế.

`suitableForMe=true` loại các món có nguyên liệu người dùng tránh, trực tiếp hoặc
qua nhóm, và món có cặp nguyên liệu vi phạm quy tắc kỵ nhau trong database. Đây
chỉ là kiểm tra từng công thức: một món có thể xung đột với món khác đã chọn trong
cùng ngày. Luôn xem trước và kiểm tra lại khi lưu. Nguyên liệu yêu thích không
phải điều kiện bắt buộc. Kết quả cá nhân có `Cache-Control: private, no-store`;
FE cần cache theo tài khoản và xóa cache khi đổi tài khoản/hồ sơ ăn uống.

Các item gồm `id`, `title`, `imageUrl`, `servings`, `prepMinutes`, `cookMinutes`,
`totalMinutes`, `ingredientCount`, `conflictCount`, `conflicts`, `post`, `updatedAt`.
`meta` dùng [hợp đồng phân trang chung](pagination.md).

## Chi tiết công thức

`GET /recipes/:id` trả các trường của item và thêm:

```ts
type RecipeDetails = {
  description: string | null;
  steps: string[];
  ingredients: {
    ingredientId: string;
    name: string;
    quantity: number | null;
    unit: string | null;
    note: string | null;
  }[];
};
```

Nguyên liệu và bước nấu giữ thứ tự do admin nhập. `imageUrl` là link HTTPS có
thể bằng `null`. `post` chỉ có `{ id, author: { username, fullName } }` khi bài
nguồn đã `PUBLISHED`; nếu bài đang xử lý, thất bại hoặc đã bị xóa thì `post=null`.
Response không trả dữ liệu đăng nhập, người tạo admin hay hồ sơ ăn uống.

Kho công thức vẫn hiển thị món có xung đột để người dùng xem cảnh báo;
`suitableForMe=true` mới loại chúng khỏi danh sách. Công thức hiện không có số
liệu calo/chất dinh dưỡng.

## Chọn món, xem trước và lưu

1. Đọc `/meal-plan` để lấy toàn bộ nội dung đang lưu.
2. Tìm món bằng `/recipes`, xem hướng dẫn bằng `/recipes/:id`.
3. Sửa ngày muốn thay đổi trên giao diện và gọi `/meal-plan/preview`.
4. Hiển thị `problems`, nội dung cũ trong `previous` và món đề xuất trong `recipes`.
5. Khi người dùng bấm **Áp dụng**, gửi cùng body tới `PUT /meal-plan/days`.
6. Nếu lưu thành công, dùng response để cập nhật thực đơn. Nếu nhận `409`, hiện
   `problems` mới vì hồ sơ/công thức/quy tắc có thể đã thay đổi sau khi xem trước.

Hai API nhận cùng body. Mỗi ngày được gửi **thay thế toàn bộ ngày đó**, nên phải
gửi đủ bốn phần, bao gồm món muốn giữ. Ngày không gửi giữ nguyên. Mảng rỗng xóa
phần đó; mỗi phần tối đa 6 món, không lặp ID trong một phần.

```json
{
  "days": [
    {
      "day": "MON",
      "breakfast": [],
      "lunch": ["d1a2d3e4-0000-4000-8000-000000000001"],
      "dinner": [],
      "others": []
    }
  ]
}
```

`day` nhận `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, `SUN`. Đây là lịch tuần lặp,
không gắn ngày tháng. `others` chứa món ngoài ba bữa chính.

Response xem trước HTTP `200`:

```ts
type Preview = {
  days: {
    day: string;
    sections: {
      section: 'BREAKFAST' | 'LUNCH' | 'DINNER' | 'OTHER';
      recipes: { id: string; title: string }[];
      previous: { id: string; title: string }[];
    }[];
  }[];
  problems: {
    code: 'UNKNOWN_RECIPE' | 'AVOIDED_INGREDIENT' | 'DAY_CONFLICT';
    day: string;
    recipes: string[];
    ingredients: string[];
    reason: string | null;
  }[];
};
```

Các vấn đề được trả về để hiển thị, không biến xem trước thành một thao tác lưu.
`PUT /meal-plan/days` trả `409` với `code: "MEAL_PLAN_INVALID"` và cùng cấu trúc
`problems` nếu đề xuất không hợp lệ; không ngày nào được ghi một phần.

Quy tắc hiện có: ngày được thêm món phải kiểm tra nguyên liệu tránh và xung đột
trên **cả ngày**, kể cả hai món thuộc hai bữa khác nhau. Chỉ xóa/di chuyển món đã
có trong cùng ngày vẫn được phép để người dùng chỉnh thực đơn cũ đang có vấn đề.
ID công thức không tồn tại luôn được báo lỗi. Xem trước không giữ chỗ hay khóa
dữ liệu; API lưu là nơi kiểm tra cuối cùng.

## Lỗi cần xử lý

| HTTP  | Trường hợp                                                |
| ----- | --------------------------------------------------------- |
| `400` | Query/body/UUID sai hoặc tham số không hỗ trợ             |
| `401` | Token sai, thiếu token trên API thực đơn hoặc lọc cá nhân |
| `404` | Công thức không tồn tại                                   |
| `409` | Lưu thực đơn không hợp lệ; đọc `code` và `problems`       |

## Kiểm tra backend

```bash
npm test
npm run test:e2e
npm run build
npm run lint
```

Test PostgreSQL thực cho tìm kiếm, tổng thời gian, phân trang và xung đột nhóm:

```powershell
$env:TEST_DATABASE_URL = "postgresql://postgres:password@localhost:5432/vedora_test"
npm run test:db
```

Dùng database test dùng riêng. Mỗi lần chạy tạo schema ngẫu nhiên, áp dụng toàn
bộ migration rồi xóa schema đó; không dùng `.env` làm kết nối test.
