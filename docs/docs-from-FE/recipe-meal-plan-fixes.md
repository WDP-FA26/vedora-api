# Lỗi và yêu cầu sửa: Kho công thức & thực đơn

- Ngày giờ: 2026-10-19 16:23 (+07:00)
- Người gửi: FE (Kim Thúy)
- Phạm vi: `GET /recipes`, `GET /recipes/:id`, `/meal-plan`, `POST /meal-plan/preview`,
  `PUT /meal-plan/days`
- Đối chiếu với: `main` @ `17dd789`, tài liệu
  [recipe-catalog-meal-plan.md](../docs-for-FE/recipe-catalog-meal-plan.md)

Các mục dưới đây rút ra từ việc đọc code, chưa tái hiện bằng request thật (test
e2e trên máy FE bị timeout ở `beforeAll`, chưa xác định nguyên nhân).

## 1. 🔴 `PUT /meal-plan/days` không an toàn khi gọi đồng thời (cần sửa)

**Vị trí:** `src/meal-plan/meal-plan.service.ts`, hàm `apply()`.

**Hiện trạng:**

- `apply()` gọi `preview()` để kiểm tra **ngoài** transaction, sau đó mới chạy
  `deleteMany` + `createMany` trong một batch `$transaction` (mức mặc định
  READ COMMITTED).
- `meal_plan_entries` có khóa chính `(user_id, day, section, recipe_id)`.
- Không có exception filter nào bắt lỗi unique index của MongoDB trên route này.

**Tình huống lỗi:**

1. **Bấm "Áp dụng" hai lần liên tiếp với cùng nội dung** (double-click, mạng
   chậm, retry): `deleteMany` của request thứ hai không thấy các dòng request đầu
   vừa thêm, nên `createMany` chèn trùng khóa → **500 Internal Server Error**.
2. **Hai request cùng ngày nhưng khác món** (hai tab, hai thiết bị): request sau
   không xóa được món của request trước, nên **món của cả hai bị gộp vào một
   ngày**. Ngày đó có thể vượt 6 món/bữa, trùng `position`, và chứa nguyên liệu
   tránh hoặc cặp kỵ nhau mà không bị kiểm tra.

**Đề xuất:**

- Đưa bước kiểm tra và bước ghi vào cùng một interactive transaction, khóa theo
  user trước khi đọc (ví dụ `SELECT ... FROM users WHERE id = $1 FOR UPDATE`
  hoặc `pg_advisory_xact_lock`).
- Bắt `P2002` (nếu vẫn có thể xảy ra) và trả `409` thay vì `500`.
- Thêm test cho hai request `PUT` gửi song song.

**Kỳ vọng:** hai request đồng thời cho kết quả như khi chạy lần lượt; không bao
giờ trả 500 và không lưu ngày chưa qua kiểm tra.

## 2. 🟡 `problems[].recipes` trả tên món, không phải ID (nên bổ sung)

**Vị trí:** `MealPlanProblemDto`, `MealPlanService.problems()`.

FE không xác định chính xác món nào bị lỗi để tô đỏ, nhất là khi hai món trùng
tên. Tài liệu hiện cũng không nói rõ đây là tên món.

**Đề xuất:** thêm `recipeIds: string[]` (giữ `recipes` để không phá FE hiện tại)
và ghi rõ trong tài liệu `recipes` là tên món.

## 3. 🟡 `UNKNOWN_RECIPE` không cho biết ID nào không tồn tại (nên bổ sung)

**Vị trí:** `MealPlanService.preview()`, vấn đề `UNKNOWN_RECIPE` luôn có
`recipes: []`.

FE chỉ báo được "ngày X có món không còn tồn tại" mà không chỉ ra món nào để
người dùng xóa.

**Đề xuất:** trả các ID không tồn tại (ví dụ trong `recipeIds` ở mục 2).

## 4. Ghi chú, không cần sửa

FE sẽ tự xử lý các hành vi sau; chỉ cần BE xác nhận đây là thiết kế đúng:

- Có header `Authorization` là bị kiểm tra, kể cả rỗng hoặc `Bearer undefined`,
  nên `GET /recipes/:id` công khai cũng có thể trả `401`.
- `q` chỉ toàn khoảng trắng bị trim thành rỗng và trả `400`.
- Ngày được thêm món thì kiểm tra lại **cả ngày**: món cũ vi phạm (sau khi đổi hồ
  sơ ăn uống) sẽ chặn việc thêm món mới cho ngày đó.
- Response preview chỉ có `{ id, title }`; FE tự lấy hình và thời gian từ dữ liệu
  khác.

## Trạng thái

| #   | Mục                       | Mức độ   | Trạng thái |
| --- | ------------------------- | -------- | ---------- |
| 1   | Lưu đồng thời             | Cần sửa  | Đã sửa BE: khóa user, kiểm tra/ghi cùng transaction |
| 2   | `recipeIds` trong lỗi     | Nên thêm | Đã bổ sung; giữ `recipes` là tên món |
| 3   | ID của `UNKNOWN_RECIPE`   | Nên thêm | Đã bổ sung ID thiếu, loại trùng theo ngày |
| 4   | Xác nhận hành vi thiết kế | Ghi chú  | Đã xác nhận trong tài liệu BE gửi FE |

## Phản hồi BE — 19/10/2026

- Nhánh: `fix/meal-plan-concurrent-save`. Trạng thái trên ghi nhận implementation;
  merge và deployment được theo dõi riêng.
- `PUT /meal-plan/days` dùng interactive transaction và `SELECT ... FOR UPDATE`
  trên user trước mọi đọc/kiểm tra/lưu. Các truy vấn kiểm tra dùng transaction
  client; response cũng được dựng trước khi nhả khóa.
- Request cùng user được tuần tự hóa, ngày không gửi giữ nguyên. Cùng ngày thì
  lần xử lý sau thay nguyên ngày; không gộp món giữa hai request.
- Lỗi DB unique/FK/write conflict trả `409 MEAL_PLAN_CONFLICT` để FE tải lại và
  preview. Lỗi nghiệp vụ tiếp tục trả `409 MEAL_PLAN_INVALID` kèm `problems`.
- `recipeIds` có trên mọi loại problem; `UNKNOWN_RECIPE` trả ID thiếu và
  `recipes=[]`. Các trường cũ giữ nguyên.
- Hợp đồng và bốn hành vi ở mục 4 được ghi tại
  [recipe-catalog-meal-plan.md](../docs-for-FE/recipe-catalog-meal-plan.md).
- Không đổi schema và không cần migration.

### Validation

- `npm test`: 36 file, 252 tests passed.
- `npm run test:e2e`: 10 file, 231 tests passed.
- `npm run test:db`: 2 file, 27 tests passed trên PostgreSQL 17 tạm thời trong
  Docker, schema riêng cho mỗi suite; gồm HTTP PUT đồng thời cùng món, khác món
  cùng ngày, khác ngày và rollback khi một ngày không hợp lệ.
- `npm run build`, `npm run lint`, `npx tsc --noEmit`, `git diff --check`: passed.
