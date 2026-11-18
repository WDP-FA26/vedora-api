# Kho công thức và chọn món vào thực đơn

Base URL: `/api/v1`. Kho công thức do admin quản lý; người dùng và guest được đọc.
Swagger mô tả đầy đủ request/response tại `/docs`. Thực đơn lưu **theo từng tuần** (xem [Thực đơn theo tuần](#thực-đơn-theo-tuần)); dữ liệu thực đơn lặp lại cũ không được chuyển sang.

## API

| Method | Endpoint             | Đăng nhập                                | Kết quả                                       |
| ------ | -------------------- | ---------------------------------------- | --------------------------------------------- |
| GET    | `/recipes`           | Không; bắt buộc nếu `suitableForMe=true` | `{ items, meta }`                             |
| GET    | `/recipes/:id`       | Không                                    | Chi tiết công thức                            |
| GET    | `/meal-plan?weekStart=` | Có                                    | Thực đơn một tuần, đủ 7 ngày và 4 phần/ngày; mặc định tuần hiện tại |
| POST   | `/meal-plan/copy`    | Có                                       | Sao chép món của một tuần sang tuần khác (không ghi đè nếu không có `overwrite`) |
| POST   | `/meal-plan/preview` | Có                                       | Đề xuất, nội dung cũ và các vấn đề; không lưu |
| POST   | `/meal-plan/generate` | Có                                      | Thuật toán (không AI) chọn món cho các ô được chọn; trả preview, không lưu |
| GET    | `/meal-plan/draft?weekStart=` | Có                              | Bản nháp chưa lưu của một tuần do trợ lý tạo, cùng dạng preview kèm `ok` (hết hạn sau 6 giờ) |
| DELETE | `/meal-plan/draft?weekStart=` | Có (`weekStart` bắt buộc)       | Xóa bản nháp chưa lưu của tuần đó (204)       |
| PUT    | `/meal-plan/days`    | Có                                       | Lưu các ngày được gửi và trả thực đơn mới     |
| POST   | `/meal-plan/chat`    | Có                                       | Chat với trợ lý (SSE); truyền thêm `threadId` để tự lưu tin nhắn |
| GET    | `/meal-plan/chat/threads` | Có                                  | Danh sách đoạn chat đã lưu (`{ items, meta }`, mới nhất trước) |
| POST   | `/meal-plan/chat/threads` | Có                                  | Tạo hoặc đảm bảo tồn tại đoạn chat (`id?`, `title?`) |
| GET    | `/meal-plan/chat/threads/:threadId` | Có                        | Chi tiết đoạn chat kèm toàn bộ `messages` và `proposalStatuses` |
| PATCH  | `/meal-plan/chat/threads/:threadId` | Có                        | Cập nhật `title`, `proposalStatuses` hoặc đồng bộ `messages` |
| DELETE | `/meal-plan/chat/threads/:threadId` | Có                        | Xóa đoạn chat và toàn bộ tin nhắn thuộc đoạn chat (204) |

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
cùng bữa. Luôn xem trước và kiểm tra lại khi lưu. Nguyên liệu yêu thích không
phải điều kiện bắt buộc. Kết quả cá nhân có `Cache-Control: private, no-store`;
FE cần cache theo tài khoản và xóa cache khi đổi tài khoản/hồ sơ ăn uống.

Các item gồm `id`, `title`, `imageUrl`, `tag`, `servings`, `prepMinutes`, `cookMinutes`,
`totalMinutes`, `ingredientCount`, `conflictCount`, `conflicts`, `post`, `updatedAt`.
`meta` dùng [hợp đồng phân trang chung](pagination.md).

Catalog/detail bổ sung `isFavorite` theo người gọi (guest=false). Mọi response
có token hợp lệ dùng `Cache-Control: private, no-store` và phân biệt cache theo
`Vary: Authorization`. Xem [Công thức yêu thích](recipe-favorites.md).

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

`tag` (tùy chọn khi `POST`/`PUT /admin/recipes`) phân loại món để lịch thực đơn
chọn biểu tượng: `SOUP`, `SALAD`, `RICE`, `NOODLES`, `STIR_FRY`, `BREAD`,
`DESSERT`, `DRINK`, `SNACK`. Bỏ qua hoặc gửi `null` là món chưa phân loại; response
trả `tag: null` và FE tự dùng biểu tượng mặc định. `PUT` thay toàn bộ, nên không
gửi `tag` sẽ xóa tag cũ. Giá trị ngoài danh sách trả `400`. `tag` cũng có trong
mỗi món của `GET /meal-plan`, và trong `recipes`/`previous` của bản xem trước.

Nguyên liệu và bước nấu giữ thứ tự do admin nhập.

## Chọn món bằng thuật toán

`POST /meal-plan/generate` chọn mỗi ô một món, không gọi AI nên trả lời nhanh và
cho kết quả tuân theo ràng buộc. Body:

| Trường | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `weekStart` | Có | Thứ Hai của tuần cần điền, `YYYY-MM-DD` |
| `days` | Có | Các thứ cần điền, ví dụ `["MON","TUE"]`. Ngày trước hôm nay bị bỏ qua; không còn ngày nào thì `days` trả về rỗng |
| `sections` | Có | Các bữa cần điền: `BREAKFAST`, `LUNCH`, `DINNER`, `OTHER` |
| `onlyEmpty` | Có | `true` giữ nguyên ô đã có món; `false` thay món ở các ô được chọn |
| `maxMinutes` | Không | 1–240; tổng sơ chế + nấu tối đa. Món chưa có thời gian bị loại khi có trường này |
| `query` | Không | Tối đa 100 ký tự; tên món hoặc nguyên liệu muốn ưu tiên, chỉ cộng điểm, không bắt buộc |
| `exclude` | Không | Tối đa 10 từ (mỗi từ ≤ 100 ký tự) mà tên món hoặc nguyên liệu không được chứa, ví dụ `["chiên"]`; bắt buộc, khác `query` |
| `tags` | Không | Chỉ chọn món có một trong các `tag` này; món chưa có `tag` bị loại, và khi đặt trường này thì không xét `tag` hợp bữa |
| `perSection` | Không | 1–6, mặc định 1; số món cho mỗi ô được điền |
| `candidateIds` | Không | Tối đa 200 UUID; giới hạn thuật toán chỉ chọn trong danh sách công thức này |
| `avoidIds` | Không | Tối đa 200 UUID; không bao giờ chọn các công thức này |
| `pinned` | Không | Danh sách `{ day, section, recipeIds? }` giữ nguyên ô đó (hoặc gán `recipeIds` trước khi điền các ô còn lại) |

Món được xếp hạng theo: `tag` hợp với bữa (ví dụ `BREAD` cho bữa sáng, `DRINK` chỉ
hợp phần Khác), nguyên liệu người dùng thích, khớp `query`; món không lặp trong cùng một
bữa (ví dụ các bữa sáng của cả tuần) trừ khi hết món khác; giữa các bữa khác nhau,
kể cả cùng một ngày, một món vẫn được dùng lại (chỉ bị trừ điểm nhẹ). Món chứa nguyên liệu người dùng không ăn, món tự xung đột và
món gây xung đột nguyên liệu với các món khác cùng bữa đều bị loại. Món chưa có
`tag` không được cộng hay trừ điểm theo bữa.

Response giống `POST /meal-plan/preview`: chỉ gồm các ngày có thay đổi, mỗi ngày đủ
bốn phần kèm `previous`. `days` rỗng khi không có món nào phù hợp. Kết quả dùng
`PUT /meal-plan/days` để lưu. Mỗi lần gọi có thể ra kết quả khác nhau.

Trợ lý chat dùng cùng thuật toán qua công cụ `fillSlots` (ghi vào bản nháp chưa lưu),
đọc thực đơn và bản nháp hiện tại bằng `getPlan`, và chỉnh từng ô bằng `editDraft`
(`set`, `add`, `remove`, `clear`, `move`). Output của `fillSlots` và `editDraft`
có cùng dạng đề xuất (`part.type` là `tool-fillSlots` hoặc `tool-editDraft`,
gồm `output.ok`, `output.days`, `output.problems`), nên FE hiển thị chúng như nhau.

Khi gửi `threadId` (UUID v4) lên `POST /meal-plan/chat`, backend tự động lưu tin
nhắn người dùng, các lượt bị từ chối bởi moderation (`metadata: { refused: true }`)
và câu trả lời stream xong của trợ lý (đầy đủ `parts`, gồm text, tool trace,
knowledge sources và proposal) vào đoạn chat đó. FE chỉ gửi tối đa 10 tin nhắn gần
nhất trong `messages` để làm ngữ cảnh cho LLM; toàn bộ tin nhắn trước đó vẫn được
giữ đầy đủ trong MongoDB và trả về qua `GET /meal-plan/chat/threads/:threadId`.
`PATCH /meal-plan/chat/threads/:threadId` dùng để cập nhật `title`, `proposalStatuses`
(`staged | saved | dismissed`) hoặc đồng bộ thêm tin nhắn theo `id` (idempotent).
 `imageUrl` là link HTTPS có
thể bằng `null`. `post` chỉ có `{ id, author: { username, fullName } }` khi bài
nguồn đã `PUBLISHED`; nếu bài đang xử lý, thất bại hoặc đã bị xóa thì `post=null`.
Response không trả dữ liệu đăng nhập, người tạo admin hay hồ sơ ăn uống.

Kho công thức vẫn hiển thị món có xung đột để người dùng xem cảnh báo;
`suitableForMe=true` mới loại chúng khỏi danh sách. Công thức hiện không có số
liệu calo/chất dinh dưỡng.

### Ảnh món

Admin tải ảnh lên Cloudinary rồi gửi URL nhận được làm `imageUrl`:

1. `POST /admin/recipes/image-uploads` (không cần body) trả `{ upload, url }`.
   `upload` có `{ url, fields, chunkSize }` giống `POST /blogs/videos/uploads`
   nhưng trỏ tới endpoint `image/upload`, chỉ nhận jpg, jpeg, png, webp.
2. Gửi `multipart/form-data` tới `upload.url` với mọi `upload.fields` và trường `file`.
   Chữ ký không giới hạn được dung lượng (Cloudinary chỉ chặn theo hạn mức của tài khoản, gói miễn phí 10 MB/ảnh), nên FE tự chặn quá 10 MB.
3. Gửi `url` làm `imageUrl` khi `POST`/`PUT /admin/recipes`.

Công thức cũ đang dùng link HTTPS ngoài vẫn hợp lệ và hiển thị bình thường; API
vẫn nhận mọi `imageUrl` HTTPS. Cloudinary chưa được cấu hình thì endpoint trả `503`.

## Thực đơn theo tuần

Mỗi tuần có thực đơn riêng, định danh bằng `weekStart`: **thứ Hai của tuần**, dạng
`YYYY-MM-DD`, tính theo múi giờ của app (`timeZone` trong `GET /config/public`). Server
quyết định tuần nào hợp lệ; FE không tự tính ngày hay đoán tuần được phép.

### Quy tắc

- **Tuần chưa lập thì rỗng.** Không có thực đơn mẫu hay kế thừa từ tuần khác. Muốn bắt đầu từ
  tuần cũ, dùng `POST /meal-plan/copy`.
- **Lên trước tối đa 4 tuần** sau tuần hiện tại (`maxWeekStart`). Xa hơn trả `409 MEAL_WEEK_OUT_OF_RANGE`
  (cả khi đọc lẫn ghi). Xem lại các tuần đã qua thì được; `minWeekStart` là tuần sớm nhất nên cho
  duyệt lùi (tuần đầu tiên có món, hoặc tuần hiện tại).
- **Ngày trước hôm nay bị khóa**: không thêm, sửa hay xóa món (`409 MEAL_DAY_LOCKED`, `details.days` liệt kê
  ngày bị khóa). Tuần đã qua chỉ đọc. Ngày tính hết lúc 00:00 theo múi giờ của app. Món đã lưu cho
  một ngày trước khi ngày đó qua vẫn hiển thị để xem lại.
- Tạo bằng thuật toán (`generate`) và trợ lý chat tự bỏ qua ngày bị khóa thay vì báo lỗi.
- Bản nháp cũng theo tuần: mỗi tuần một bản nháp riêng, hết hạn sau 6 giờ. Lưu một tuần chỉ xóa nháp
  của tuần đó.

### Response `GET /meal-plan`

```ts
type MealPlan = {
  weekStart: string;        // thứ Hai của tuần này
  currentWeekStart: string; // thứ Hai của tuần chứa hôm nay
  today: string;            // hôm nay, YYYY-MM-DD
  minWeekStart: string;     // tuần sớm nhất nên cho xem lại
  maxWeekStart: string;     // tuần xa nhất được lập
  editable: boolean;        // false: cả tuần đã qua, không đổi được gì
  days: {
    day: 'MON' | 'TUE' | 'WED' | 'THU' | 'FRI' | 'SAT' | 'SUN';
    date: string;           // ngày tháng của thứ này trong tuần
    editable: boolean;      // false: trước hôm nay, chỉ đọc
    sections: { section: string; recipes: Recipe[] }[];
  }[];
  problems: Problem[];      // chỉ xét các ngày còn sửa được
};
```

Dùng `editable` để khóa kéo-thả và nút lưu; không tự so ngày ở phía FE. `weekStart` là
tham số query tùy chọn (mặc định tuần hiện tại); `PUT /meal-plan/days`, `POST /meal-plan/preview`,
`POST /meal-plan/generate` và `POST /meal-plan/chat` **bắt buộc** `weekStart` trong body.
`DELETE /meal-plan/draft` bắt buộc `?weekStart=`.

### Sao chép tuần: `POST /meal-plan/copy`

```json
{ "fromWeekStart": "2026-11-16", "toWeekStart": "2026-11-23", "overwrite": false }
```

Chép món của tuần nguồn sang các ngày **còn sửa được** của tuần đích, kiểm tra như `PUT /meal-plan/days`,
tất cả hoặc không gì. Mặc định từ chối (`409 MEAL_WEEK_NOT_EMPTY`) khi tuần đích đã có món ở các ngày đó;
`overwrite: true` thay thế (kể cả xóa món ở ngày nguồn trống). Tuần nguồn có thể là tuần đã qua.
Trả thực đơn của tuần đích. Hai tuần giống nhau trả `400`. Món nguồn nay chứa nguyên liệu người dùng
tránh thì `409 MEAL_PLAN_INVALID`; người dùng sửa món đó rồi sao chép lại.

### Trợ lý chat

Request mang `weekStart` của tuần đang mở. Trợ lý chỉ đọc và đề xuất cho tuần đó; khi người dùng nói
"tuần sau", trợ lý bảo họ chuyển sang tuần ấy rồi hỏi lại. Output `fillSlots` và `editDraft` có `weekStart`;
khi người dùng bấm **Áp dụng**, FE gửi `weekStart` của đề xuất đó (không phải tuần đang xem lúc bấm) tới
`PUT /meal-plan/days`.

### Danh sách đi chợ

`GET /meal-plan/shopping-list?weekStart=` tính trên một tuần; xem [meal-plan-shopping-list.md](meal-plan-shopping-list.md).

## Chọn món, xem trước và lưu

1. Đọc `/meal-plan?weekStart=` để lấy toàn bộ nội dung đang lưu của tuần đang xem.
2. Tìm món bằng `/recipes`, xem hướng dẫn bằng `/recipes/:id`.
3. Sửa ngày muốn thay đổi trên giao diện và gọi `/meal-plan/preview`.
4. Hiển thị `problems`, nội dung cũ trong `previous` và món đề xuất trong `recipes`.
5. Khi người dùng bấm **Áp dụng**, gửi cùng body (cùng `weekStart`) tới `PUT /meal-plan/days`.
6. Nếu lưu thành công, dùng response để cập nhật thực đơn. Nếu nhận `409`, hiện
   `problems` mới vì hồ sơ/công thức/quy tắc có thể đã thay đổi sau khi xem trước.

Hai API nhận cùng body. Mỗi ngày được gửi **thay thế toàn bộ ngày đó**, nên phải
gửi đủ bốn phần, bao gồm món muốn giữ. Ngày không gửi giữ nguyên. Mảng rỗng xóa
phần đó; mỗi phần tối đa 5 món, không lặp ID trong một phần.

```json
{
  "weekStart": "2026-11-16",
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

`weekStart` là **bắt buộc**: thứ Hai của tuần, `YYYY-MM-DD`; thứ khác hoặc ngày không có thật trả `400`.
`day` nhận `MON`, `TUE`, `WED`, `THU`, `FRI`, `SAT`, `SUN`; ngày tháng của từng thứ do server
trả trong `days[].date`. `others` chứa món ngoài ba bữa chính.

Response xem trước HTTP `200`:

```ts
type Preview = {
  weekStart: string; // tuần của đề xuất; lưu đúng tuần này
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
    recipes: string[]; // Tên món để hiển thị; không dùng làm định danh.
    recipeIds: string[]; // ID các món liên quan; UNKNOWN_RECIPE trả ID không tồn tại.
    ingredients: string[];
    reason: string | null;
  }[];
};
```

Các vấn đề được trả về để hiển thị, không biến xem trước thành một thao tác lưu.
`PUT /meal-plan/days` trả `409` với `code: "MEAL_PLAN_INVALID"` và cùng cấu trúc
`problems` khi có `AVOIDED_INGREDIENT` hoặc `UNKNOWN_RECIPE`; không ngày nào được
ghi một phần. `DAY_CONFLICT` chỉ là **cảnh báo**: thực đơn vẫn được lưu (`200`) và
xung đột nằm trong `problems` của response. FE hiển thị cảnh báo, không chặn người dùng.

Quy tắc hiện có: ngày được thêm món phải kiểm tra nguyên liệu tránh (chặn) trên cả
ngày. Xung đột nguyên liệu (`DAY_CONFLICT`, chỉ cảnh báo) chỉ xét **trong cùng một
bữa**: hai món ở hai bữa khác nhau, kể cả cùng ngày, không xung đột. Bữa nào được
thêm món (kể cả món chuyển từ bữa khác) thì được kiểm tra lại, và một công thức tự
chứa hai nguyên liệu xung đột vẫn bị cảnh báo. Tên mã `DAY_CONFLICT` được giữ để không
đổi contract; ý nghĩa hiện là "xung đột trong cùng bữa" và `day` là ngày của bữa đó.
Chỉ xóa món vẫn được phép để người dùng chỉnh thực đơn cũ đang có vấn đề.
ID công thức không tồn tại luôn được báo lỗi. Xem trước không giữ chỗ hay khóa
dữ liệu; API lưu là nơi kiểm tra cuối cùng.

Mỗi `PUT /meal-plan/days` khóa theo user trước khi đọc/kiểm tra, rồi thay các ngày
và dựng response trong cùng transaction. Hai request cùng user được xử lý tuần tự:
cùng ngày thì request được xử lý sau thay toàn bộ ngày, không gộp hai danh sách;
khác ngày thì giữ cả hai thay đổi. FE vẫn cần gửi đầy đủ bốn phần của ngày.
Chưa có `expectedVersion`: đây không phải cơ chế phát hiện bản nháp cũ giữa hai tab.

`recipeIds` có ở cả response GET, preview và trong `details.problems` của lỗi lưu `MEAL_PLAN_INVALID`:

- `AVOIDED_INGREDIENT`: ID công thức chứa nguyên liệu tránh.
- `DAY_CONFLICT`: ID các công thức tham gia xung đột, tương ứng với tên trong `recipes`.
- `UNKNOWN_RECIPE`: các ID không tồn tại, không lặp trong cùng ngày; `recipes=[]`
  vì backend không có tên để trả. ID thiếu không xuất hiện trong món preview.

Nếu database phát hiện xung đột ghi/tham chiếu, API trả `409 MEAL_PLAN_CONFLICT`;
FE tải lại thực đơn và preview trước khi thử lưu lại. Không dựa vào trường
`details.problems` cho mã lỗi này. Các lỗi validation nghiệp vụ vẫn trả
`409 MEAL_PLAN_INVALID` với `details.problems`.

## Lỗi cần xử lý

| HTTP  | Trường hợp                                                |
| ----- | --------------------------------------------------------- |
| `400` | Query/body/UUID sai hoặc tham số không hỗ trợ             |
| `401` | Token sai, thiếu token trên API thực đơn hoặc lọc cá nhân |
| `404` | Công thức không tồn tại                                   |
| `409` | `MEAL_PLAN_INVALID` kèm `details.problems`; `MEAL_PLAN_CONFLICT` cần tải lại và preview; `MEAL_DAY_LOCKED`, `MEAL_WEEK_OUT_OF_RANGE`, `MEAL_WEEK_NOT_EMPTY` (xem [Thực đơn theo tuần](#thực-đơn-theo-tuần)) |

Xác nhận hành vi FE hỏi ngày 19/10/2026:

- Có header `Authorization` thì token luôn được kiểm, kể cả header rỗng hoặc
  `Bearer undefined`; sai trả `401` trên API công thức công khai.
- `q` chỉ có khoảng trắng trở thành chuỗi rỗng sau trim và trả `400`.
- Thêm món phải kiểm tra lại nguyên liệu tránh trên **cả ngày** và xung đột trong **bữa** nhận món, bao gồm món cũ vi phạm sau đổi hồ sơ.
- Preview chỉ trả `{ id, title }` cho món; FE lấy ảnh/thời gian từ catalog/detail.

## Kiểm tra backend

```bash
npm test
npm run test:e2e
npm run build
npm run lint
```

Test PostgreSQL thực cho tìm kiếm, tổng thời gian, phân trang, xung đột nhóm và
các request HTTP lưu thực đơn đồng thời:

```powershell
$env:TEST_DATABASE_URL = "mongodb://vedora:vedora_local_password@localhost:27017/?authSource=admin&directConnection=true"
npm run test:db
```

Dùng database test dùng riêng. Mỗi lần chạy tạo schema ngẫu nhiên, áp dụng toàn
bộ migration rồi xóa schema đó; không dùng `.env` làm kết nối test.
