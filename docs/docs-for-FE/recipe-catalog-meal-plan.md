# Kho công thức và chọn món vào thực đơn

Base URL: `/api/v1`. Kho công thức do admin quản lý; người dùng và guest được đọc.
Swagger mô tả đầy đủ request/response tại `/docs`. Thực đơn lưu **theo từng tuần** (xem [Thực đơn theo tuần](#thực-đơn-theo-tuần)); dữ liệu thực đơn lặp lại cũ không được chuyển sang.

## API

| Method | Endpoint             | Đăng nhập                                | Kết quả                                       |
| ------ | -------------------- | ---------------------------------------- | --------------------------------------------- |
| `GET`  | `/dietary/me`         | Có                                       | Ghi nhớ của trợ lý: `{ allergies: string[], preferences: string[] }` (xem [Ghi nhớ](#ghi-nhớ-dị-ứng--sở-thích-dietaryme)) |
| `PUT`  | `/dietary/me`         | Có                                       | Thay `allergies` và/hoặc `preferences` (bỏ trường thì giữ nguyên) |
| `GET`  | `/dietary/nutrition`  | Có                                       | Hồ sơ BMI chuẩn Châu Á, mục tiêu năng lượng (TDEE ±15%) và lịch sử check-in cân nặng |
| `PUT`  | `/dietary/nutrition`  | Có                                       | Cập nhật chiều cao, cân nặng, mục tiêu BMI, năm sinh, giới tính, mức vận động |
| `POST` | `/dietary/nutrition/check-in` | Có                               | Ghi nhận cân nặng & cảm giác cơ thể theo ngày (`YYYY-MM-DD`, tối đa 1 bản ghi/ngày) |
| GET    | `/recipes`           | Không; bắt buộc nếu `suitableForMe=true` | `{ items, meta }`                             |
| GET    | `/recipes/:id`       | Không                                    | Chi tiết công thức                            |
| GET    | `/meal-plan?weekStart=` | Có                                    | Thực đơn một tuần, đủ 7 ngày và 4 phần/ngày; mặc định tuần hiện tại |
| POST   | `/meal-plan/copy`    | Có                                       | Sao chép món của một tuần sang tuần khác (không ghi đè nếu không có `overwrite`) |
| POST   | `/meal-plan/preview` | Có                                       | Đề xuất, nội dung cũ và các vấn đề; không lưu |
| POST   | `/meal-plan/generate` | Có                                      | Thuật toán (không AI) chọn món cho các ô được chọn; trả preview, không lưu |
| PUT    | `/meal-plan/days`    | Có                                       | Lưu các ngày được gửi và trả thực đơn mới     |
| POST   | `/meal-plan/chat`    | Có                                       | Chat với trợ lý (SSE); truyền thêm `threadId` để tự lưu tin nhắn |
| GET    | `/meal-plan/chat/threads` | Có                                  | Danh sách đoạn chat đã lưu (`{ items, meta }`, mới nhất trước) |
| POST   | `/meal-plan/chat/threads` | Có                                  | Tạo hoặc đảm bảo tồn tại đoạn chat (`id?`, `title?`) |
| GET    | `/meal-plan/chat/threads/:threadId` | Có                        | Chi tiết đoạn chat kèm toàn bộ `messages` và `proposalStatuses` |
| PATCH  | `/meal-plan/chat/threads/:threadId` | Có                        | Cập nhật `title`, `proposalStatuses` hoặc đồng bộ `messages` |
| POST   | `/meal-plan/chat/threads/:threadId/rewind` | Có                 | Quay lại trước một tin nhắn của người dùng: khôi phục các món trợ lý đã đổi từ tin đó trở đi và xóa tin đó cùng mọi tin sau |
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

`suitableForMe=true` loại các món có nguyên liệu khớp từ khoá dị ứng suy ra từ
`allergies` (ví dụ "dị ứng đậu nành" → đậu hũ, nước tương…), và món có cặp nguyên liệu vi phạm quy tắc kỵ nhau trong database. Đây
chỉ là kiểm tra từng công thức: một món có thể xung đột với món khác đã chọn trong
cùng bữa. Luôn xem trước và kiểm tra lại khi lưu. Kết quả cá nhân có `Cache-Control: private, no-store`;
FE cần cache theo tài khoản và xóa cache khi đổi tài khoản/hồ sơ ăn uống.

Các item gồm `id`, `title`, `imageUrl`, `tag`, `servings`, `prepMinutes`, `cookMinutes`,
`totalMinutes`, `caloriesPerServing`, `nutritionPillars`, `ingredientCount`, `conflictCount`, `conflicts`, `post`, `updatedAt`.
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
hợp phần Khác), khớp `query`; món không lặp trong cùng một
bữa (ví dụ các bữa sáng của cả tuần) trừ khi hết món khác; giữa các bữa khác nhau,
kể cả cùng một ngày, một món vẫn được dùng lại (chỉ bị trừ điểm nhẹ). Món chứa nguyên liệu người dùng không ăn, món tự xung đột và
món gây xung đột nguyên liệu với các món khác cùng bữa đều bị loại. Món chưa có
`tag` không được cộng hay trừ điểm theo bữa.

Response giống `POST /meal-plan/preview`: chỉ gồm các ngày có thay đổi, mỗi ngày đủ
bốn phần kèm `previous`. `days` rỗng khi không có món nào phù hợp. Kết quả dùng
`PUT /meal-plan/days` để lưu. Mỗi lần gọi có thể ra kết quả khác nhau.

Trợ lý chat dùng cùng thuật toán qua công cụ `fillSlots`, đọc thực đơn bằng `getPlan`,
chỉnh từng ô bằng `editPlan` (`set`, `add`, `remove`, `clear`, `move`) và cân đối Kcal bằng
`autoBalancePlan`. Các công cụ này **lưu thẳng vào thực đơn** (không còn bản nháp hay nút "Áp dụng").
Output của `fillSlots`, `editPlan`, `autoBalancePlan` và `verifyMealPlanAllergies` (khi nó đổi món) có cùng
dạng thay đổi: `output.weekStart`, `output.days` (chỉ ngày đổi, đủ bốn phần, `previous` là món trước lần gọi,
`recipes` là món sau), `output.problems` và `output.applied` (`false` khi không lưu gì). Món không tồn tại
(`UNKNOWN_RECIPE`) hoặc có nguyên liệu khớp dị ứng của người dùng (`AVOIDED_INGREDIENT`) bị **bỏ ra**, phần còn lại vẫn được lưu;
hai mã đó nằm trong `output.problems` để FE ghi "Không thêm: …". `applied: false` khi không có thay đổi, hoặc mọi món
mới đều bị bỏ. FE hiển thị thẻ "Đã cập nhật thực đơn" và tải lại `GET /meal-plan`.

Khi gửi `POST /meal-plan/chat` với `{ weekStart, message, threadId?, requestId?, allowWebSearch?, toolOutput? }`, backend tự động lưu tin nhắn người dùng, các lượt bị từ chối bởi moderation (`metadata: { refused: true }`) và câu trả lời stream xong của trợ lý (đầy đủ `parts`, gồm text, tool trace, knowledge sources và các thay đổi thực đơn) vào đoạn chat `threadId` đó. Nếu gửi kèm `toolOutput` (`askUser` hoặc `requestWebSearch`), backend gắn luôn kết quả vào part tương ứng của tin nhắn trợ lý trước đó mà không cần FE đồng bộ lại bằng `PATCH`.

Ngữ cảnh hội thoại được nạp hoàn toàn ở phía server: backend lấy tối đa `PLANNER_CHAT_MAX_MESSAGES` (mặc định 40) tin nhắn hợp lệ gần nhất từ MongoDB (loại bỏ các lượt đã bị moderation từ chối), kiểm tra lại lịch sử bằng `validateUIMessages` với bộ công cụ hiện tại (nếu lịch sử không còn khớp schema, lượt đó bắt đầu lại chỉ với tin nhắn mới nhất), chuyển đổi lịch sử `UIMessage` sang `ModelMessage` qua `convertToModelMessages` (`toModelOutput` gọn của từng công cụ) và cắt tỉa kết quả tra cứu cũ bằng `pruneMessages`, nên FE không cần nén ghi chú công cụ hay gửi lại toàn bộ mảng `messages` mỗi lượt. Toàn bộ tin nhắn đầy đủ vẫn được giữ trong MongoDB và trả về qua `GET /meal-plan/chat/threads/:threadId`. `PATCH /meal-plan/chat/threads/:threadId` dùng để cập nhật `title` (hoặc đồng bộ bổ sung theo `id`, idempotent). `proposalStatuses` chỉ còn cho đoạn chat cũ từ thời có thẻ đề xuất; FE mới không ghi nữa.
 `imageUrl` là link HTTPS có
thể bằng `null`. `post` chỉ có `{ id, author: { username, fullName } }` khi bài
nguồn đã `PUBLISHED`; nếu bài đang xử lý, thất bại hoặc đã bị xóa thì `post=null`.
Response không trả dữ liệu đăng nhập, người tạo admin hay hồ sơ ăn uống.

Kho công thức vẫn hiển thị món có xung đột để người dùng xem cảnh báo;
`suitableForMe=true` mới loại chúng khỏi danh sách. Mỗi công thức trả về thêm
`caloriesPerServing` (kcal ước tính cho **1 suất cá nhân**, tách biệt với `servings` là số
suất cả nồi dùng cho danh sách đi chợ) và `nutritionPillars` (`PLANT_PROTEIN`, `FIBER_VEG`,
`HEALTHY_FAT`, `IRON_RICH`, `CALCIUM_RICH`) suy từ nguyên liệu.

## Ghi nhớ: dị ứng & sở thích (`/dietary/me`)

Trợ lý lên thực đơn nhớ hai danh sách câu ngắn bằng ngôn ngữ tự nhiên, người dùng xem và sửa được trong Hồ sơ ăn uống:

- `allergies`: dị ứng, không dung nạp, thứ không được ăn vì sức khoẻ hay tôn giáo ("Dị ứng đậu phộng", "Ăn chay ngũ vị tân").
  Backend suy từ khoá dị ứng từ các dòng này để loại món khi lên thực đơn, chặn lưu món (`AVOIDED_INGREDIENT`), lọc
  `suitableForMe` và đánh dấu món nhà hàng.
- `preferences`: sở thích, thói quen lâu dài ("Không thích nấm", "Chỉ nấu bữa tối", "Nấu cho 3 người"). Chỉ trợ lý đọc.

`PUT /dietary/me` nhận `{ allergies?: string[], preferences?: string[] }`, mỗi danh sách tối đa 30 dòng, mỗi dòng ≤ 200
ký tự; backend trim từng dòng, bỏ dòng rỗng và dòng trùng. Bỏ một trường thì giữ nguyên danh sách đó; gửi `[]` thì xoá hết.
Response giống `GET`. Không còn nguyên liệu/nhóm tránh theo ID, `allergyNote`, `preferenceNote` hay `GET /dietary/options`;
ghi chú cũ của tài khoản được tự tách thành dòng ở lần đọc đầu tiên.

## Hồ sơ BMI Châu Á, TDEE & Lịch sử cân nặng (`/dietary/nutrition`)

- `GET /dietary/nutrition`: trả `heightCm`, `weightKg`, `targetWeightKg`, `birthYear`, `biologicalSex`,
  `activityLevel`, `nutritionGoal`, các trường tính toán theo chuẩn BMI Châu Á (`bmi`, `bmiCategory`:
  `UNDERWEIGHT < 18.5 | NORMAL 18.5–22.9 | OVERWEIGHT 23.0–24.9 | OBESE >= 25.0`, `suggestedGoal`,
  `effectiveGoal`, `idealWeightMinKg`, `idealWeightMaxKg`, `bmr`, `tdee`, `dailyCalorieTarget`, vùng
  linh hoạt ±15% `dailyCalorieMin`–`dailyCalorieMax`, `safetyNote`) và mảng `history` tối đa 90 lần ghi
  nhận gần nhất.
- `PUT /dietary/nutrition`: cập nhật thông số thể trạng/mục tiêu; nếu đồng thời truyền `heightCm` + `weightKg`,
  tự ghi nhận bản ghi `BodyMetricLog` cho ngày hôm nay. Từ chối `400 UNSAFE_TARGET_WEIGHT` nếu đặt mục
  tiêu giảm cân dưới ngưỡng BMI 18,5.
- `POST /dietary/nutrition/check-in`: ghi nhận `{ weightKg, heightCm?, date?, feeling?, note? }` cho một ngày
  (`<= today`). Ghi đè nếu cùng ngày đã có bản ghi, và đồng bộ `weightKg` mới nhất lên hồ sơ người dùng.

Thuật toán `generate`/`fillSlots`/`autoBalancePlan` tự động cộng điểm cho món hợp mục tiêu BMI (tối thanh nhẹ khi `LOSE_WEIGHT`, ghép nhiều món bổ trợ cho mâm cơm cân bằng hoặc khi hụt Kcal để tiệm cận mục tiêu `~88%–115%` Kcal/ngày, nhưng bỏ qua các ngày ăn thiếu bữa chính do ăn ngoài) và cân bằng 5 nhóm dưỡng chất chay theo từng ngày. Trợ lý chat (`POST /meal-plan/chat`) nhận ngữ cảnh BMI, `allergies`/`preferences`, calo ước tính và xu hướng cân nặng, được trang bị:
- `autoBalancePlan`: tự động cân đối & bổ sung món kết hợp (kể cả phần `OTHER`) khi thực đơn đang hụt/dư Kcal.
- `consultNutritionSubagent`: subagent nghiên cứu dinh dưỡng có sẵn `webSearch` + `searchRecipes` để tra món ăn ngoài hệ thống, tính Kcal còn lại và gợi ý món Vedora tương ứng.
- `verifyMealPlanAllergies`: subagent kiểm định dị ứng đọc toàn bộ nguyên liệu + bước nấu của các món trên lịch đối chiếu với các dòng `allergies` ngôn ngữ tự nhiên và tự động đổi sang món an toàn nếu phát hiện rủi ro.

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
- Tạo bằng thuật toán (`generate`) bỏ qua ngày bị khóa thay vì báo lỗi; trợ lý chat cũng bỏ qua nhưng báo
  `DAY_PASSED` để nói lại với người dùng.

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

Request mang `weekStart` của tuần đang xem; đó chỉ là tuần **mặc định**. Prompt có bảng lịch của tuần này
và 4 tuần tới kèm ngày tháng, nên trợ lý tự hiểu "tuần sau", "25/11" hay "T4" và sửa bất kỳ tuần nào
trong khoảng đó mà người dùng không cần chuyển trang. Khi tuần đang xem đã qua hết, mặc định là tuần hiện tại.

- `getPlan`, `fillSlots`, `editPlan`, `autoBalancePlan` nhận `weekStart` tùy chọn (chỉ các tuần lập được). Mỗi
  output thay đổi có `weekStart` của nó; một tin nhắn có thể đổi nhiều tuần, và nhiều output của cùng một tuần
  (ví dụ `fillSlots` rồi `verifyMealPlanAllergies`) nối tiếp nhau: `previous` của output đầu là trạng thái trước tin nhắn.
- Người dùng nhắc ngày đã qua: công cụ báo `DAY_PASSED`, trợ lý nói rõ ngày đó không sửa được và hỏi có muốn lên
  cho đúng thứ đó của tuần sau không.
- Trùng món kỵ nhau trong ngày (`DAY_CONFLICT`) vẫn được lưu và nằm trong `output.problems` như cảnh báo.
- Mỗi lượt có tối đa `PLANNER_CHAT_MAX_STEPS` (mặc định 20) bước; ở bước cuối trợ lý không gọi công cụ nữa mà tóm
  tắt đã làm gì, phần nào chưa xong và hỏi có làm tiếp không.
- FE có nút Dừng (`stop()` của `useChat`); những gì công cụ đã lưu trước đó vẫn giữ. Tin nhắn gõ trong lúc trợ lý
  đang chạy được xếp hàng và gửi khi lượt hiện tại kết thúc.

#### Ghi nhớ vào hồ sơ: `updateMemory`

Trợ lý đọc `allergies` (mục "Dị ứng") và `preferences` (mục "Sở thích") ở đầu mỗi đoạn chat, và tự thêm/bớt dòng khi
người dùng kể thêm trong lúc chat bằng `updateMemory` với input
`{ section: 'allergies' | 'preferences', add?: string[], remove?: string[] }` (`remove` khớp đúng dòng đang lưu).
Trợ lý chỉ bỏ một dòng dị ứng khi người dùng nói rõ và đã xác nhận qua `askUser`; sau khi thêm dị ứng thì chạy
`verifyMealPlanAllergies` nếu lịch đã có món. Dị ứng mới có hiệu lực ngay trong lượt đó.
Output: `{ section, lines: string[] }` (danh sách mới của mục đó).

FE hiện thẻ "Đã cập nhật Sở thích/Dị ứng trong hồ sơ" và tải lại `GET /dietary/me`.

#### Hỏi người dùng: `askUser`

Khi yêu cầu còn mở (đổi món nhưng chưa nói đổi sang gì, chưa rõ ngày/bữa), thay đổi trái với điều người dùng nói
trước đó hoặc với mục Sở thích, hoặc có điểm cần lưu ý (dị ứng, ngày đã qua, Kcal lệch xa), trợ lý gọi `askUser` với input
`{ question: string; options: string[] (2–6, mỗi cái ≤ 80 ký tự); multiple?: boolean }`. Công cụ **không có output**
trên server: luồng dừng ở part `tool-askUser` với `state: 'input-available'`. FE hiện `options` thành nút; khi người
dùng chọn, FE `addToolOutput({ tool: 'askUser', toolCallId, output: { answer } })` rồi gửi `message: answer` kèm
`toolOutput: { tool: 'askUser', toolCallId, output: { answer } }` trên `POST /meal-plan/chat` để server cập nhật part
và tiếp tục lượt mới. Nếu người dùng gõ câu trả lời khác thay vì bấm nút, FE vẫn gửi câu đó làm `toolOutput` của câu hỏi đang mở.
Tool call phía client (`askUser`, `requestWebSearch`) không bao giờ nhận được output sẽ bị bỏ khỏi ngữ cảnh của model (`ignoreIncompleteToolCalls`).

#### Quay lại: `POST /meal-plan/chat/threads/:threadId/rewind`

```json
{ "messageId": "<id của tin nhắn người dùng>" }
```

Giống "rewind" của Claude Code: backend đọc các output thay đổi (`applied: true`) từ tin nhắn đó trở đi, đưa mỗi
ngày bị đổi về `previous` của lần đổi **đầu tiên** (qua `PUT /meal-plan/days` nội bộ), rồi xóa tin nhắn đó cùng mọi tin
sau khỏi đoạn chat. Response:

```ts
type ChatRewind = {
  text: string; // nội dung tin nhắn bị xóa, để đưa lại vào ô nhập
  weeks: {
    weekStart: string;
    restored: Weekday[];
    skipped: Weekday[];     // ngày đã qua nên giữ nguyên
    droppedDishes: number;  // món cũ đã bị xóa hoặc nay bị tránh nên không thêm lại
  }[];
};
```

- `404` khi đoạn chat hoặc tin nhắn người dùng không có (ví dụ lượt bị lỗi trước khi được lưu): FE chỉ cần cắt
  hội thoại ở phía client, thực đơn không có gì để khôi phục.
- Khôi phục ghi đè cả những sửa tay của người dùng trên cùng ngày sau tin nhắn đó.

#### Tìm trên web (cần người dùng cho phép)

Trợ lý chỉ được tìm trên web khi người dùng đã đồng ý trong đoạn chat đó. Backend quyết định theo cờ trong body,
không theo prompt:

- `allowWebSearch` (boolean, tùy chọn, mặc định `false`) trong body `POST /meal-plan/chat`.
- **Chưa cho phép** (`false`/bỏ trống): trợ lý chỉ có công cụ `requestWebSearch` với input `{ reason: string }`
  (≤ 200 ký tự). Công cụ này **không có output**: luồng dừng ở part `tool-requestWebSearch` với
  `state: 'input-available'`. FE hiện thẻ xin phép gồm `reason` và cảnh báo rằng thông tin trên web có thể sai
  hoặc không thống nhất, Vedora không kiểm chứng.
  - **Cho phép**: FE gắn output `{ approved: true }` vào part đó (`addToolOutput`), rồi gửi một lượt người dùng
    ngắn với `allowWebSearch: true` và `toolOutput: { tool: 'requestWebSearch', toolCallId, output: { approved: true } }`. Các lượt sau trong đoạn chat đó tiếp tục gửi `allowWebSearch: true`.
  - **Không**: gắn `{ approved: false }` rồi gửi một lượt "không" kèm `toolOutput: { tool: 'requestWebSearch', toolCallId, output: { approved: false } }`; trợ lý không hỏi lại trong đoạn chat đó trừ khi
    người dùng tự yêu cầu.
  - Quyết định được server lưu trực tiếp vào `parts` của tin nhắn trợ lý khi nhận `toolOutput`, nên FE
    dựng lại trạng thái đồng ý từ quyết định mới nhất khi mở lại đoạn chat. Đoạn chat mới luôn bắt đầu chưa cho phép.
- **Đã cho phép** (`true`, mặc định trên FE từ đầu hội thoại; có thể tắt nếu người dùng từ chối): trợ lý có công cụ server `openrouter:web_search` của OpenRouter (engine Parallel chế độ `fast`, context `medium`, tối đa `PLANNER_WEB_SEARCH_MAX_USES` = 4 lần, 5 kết quả/lần) và có thể ủy quyền tra cứu sâu cho `consultNutritionSubagent`. Nguồn web đến dưới dạng part `source-url` (`{ sourceId, url, title }`) để FE hiển thị riêng.
- Món trong thực đơn vẫn chỉ lấy từ kho món của Vedora. Phí tìm web nằm trong cùng một lượt AI (một ticket quota).

### Danh sách đi chợ

`GET /meal-plan/shopping-list?weekStart=` tính trên một tuần; xem [meal-plan-shopping-list.md](meal-plan-shopping-list.md).

Món đã thực sự ăn (kể cả món ngoài thực đơn) và thống kê kcal theo tuần: xem [meal-log.md](meal-log.md).

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
