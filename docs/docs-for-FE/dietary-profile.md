# Hồ sơ chế độ ăn và dị ứng

Base URL: `/api/v1`. Hồ sơ chỉ thuộc tài khoản đang đăng nhập, kể cả khi người
gọi là Admin. Không gửi `userId`. Response hồ sơ dùng
`Cache-Control: private, no-store`; cache FE phải gắn tài khoản và xóa khi logout.

## API và phiên bản

| Method | Endpoint           | Hành vi                                                              |
| ------ | ------------------ | -------------------------------------------------------------------- |
| GET    | `/dietary/options` | Ingredient đang active, nhóm dietary, danh sách nhãn ANIMAL/ALLERGEN |
| GET    | `/dietary/me`      | Hồ sơ, loại trừ, nguyên liệu thích và version                        |
| PATCH  | `/dietary/me`      | Sửa field được gửi; bắt buộc expectedVersion                         |
| PUT    | `/dietary/me`      | API cũ, thay PERSONAL exclusions/liked; nay cần expectedVersion      |

GET trả:

```json
{
  "dietMode": "VEGETARIAN",
  "allergyAcknowledgement": "UNCONFIRMED",
  "version": 0,
  "updatedAt": null,
  "readyForMealPlanning": false,
  "exclusions": [],
  "ingredients": [],
  "groups": [],
  "liked": []
}
```

`ingredients/groups` là danh sách ID/tên không trùng của các loại trừ trực tiếp
để hỗ trợ FE cũ. `exclusions` mới là nguồn đầy đủ về target/lý do, bao gồm nhãn.
`liked` là ID/tên nguyên liệu yêu thích. Field hồ sơ không xuất hiện trong
response công thức công khai hoặc profile xã hội.

Ví dụ xác nhận dị ứng sữa, chọn Vegan:

```json
{
  "expectedVersion": 0,
  "dietMode": "VEGAN",
  "allergyAcknowledgement": "DECLARED",
  "exclusions": [
    { "kind": "ALLERGEN", "target": "MILK", "reasons": ["ALLERGY"] },
    {
      "kind": "INGREDIENT",
      "target": "a1a2d3e4-0000-4000-8000-000000000001",
      "reasons": ["ALLERGY", "PERSONAL"]
    }
  ],
  "likedIngredientIds": []
}
```

- `expectedVersion`: số nguyên 0–2147483646, lấy từ GET gần nhất. Mỗi lần
  cập nhật thành công tăng 1 và trả hồ sơ từ cùng transaction.
- `dietMode`: `VEGETARIAN | VEGAN`. Vegetarian là lacto-ovo; thịt/cá/hải sản
  và dẫn xuất từ giết mổ không được đánh dấu Vegetarian.
- `allergyAcknowledgement`: `UNCONFIRMED | NONE_DECLARED | DECLARED`.
  Người dùng phải tự chọn; FE không mặc định NONE_DECLARED.
- `exclusions`: thay toàn bộ danh sách thủ công nếu gửi, tối đa 300 target,
  không trùng kind/target; target INGREDIENT/GROUP là UUID v4 trong catalog.
  Mỗi target có 1–3 lý do `DIET | ALLERGY | PERSONAL`.
- `ANIMAL/ALLERGEN` dùng nhãn trả từ options. ANIMAL không nhận reason ALLERGY:
  dùng Ingredient, Group hoặc Allergen tương ứng để khai báo dị ứng.
- `likedIngredientIds`: thay toàn bộ danh sách thích, tối đa 100 UUID v4
  khác nhau. Không chấp nhận nguyên liệu đồng thời bị loại trừ trực tiếp,
  qua nhóm hoặc nhãn. Sở thích không vượt qua điều kiện loại trừ.
- Field bỏ qua giữ nguyên. Field null, field lạ, body chỉ expectedVersion
  hoặc reasons rỗng đều bị từ chối. UUID target được chuẩn hóa chữ thường.

Chọn Vegan tự áp dụng DIET cho toàn bộ nhãn động vật. Đây là loại trừ theo
nhãn, áp dụng cả với nguyên liệu được thêm/phân loại sau này. FE không cần
tự tìm mọi Ingredient động vật và lưu các ID vào profile.

Chuyển về Vegetarian bằng PATCH với dietMode và expectedVersion, **bỏ qua
exclusions** để giữ danh sách hiện tại. Server gỡ DIET, giữ ALLERGY/PERSONAL.
Nếu FE gửi exclusions thì đó là thay toàn bộ danh sách thủ công; cần giữ các
lý do dị ứng mà người dùng chưa chủ động xóa.

DECLARED cần ít nhất một exclusion ALLERGY; NONE_DECLARED không được đi cùng
ALLERGY. UNCONFIRMED có thể lưu hồ sơ đang nhập nhưng chưa lập thực đơn.
NONE_DECLARED chỉ có nghĩa người dùng chưa khai báo dị ứng, không bảo đảm
họ không dị ứng.

## Khả năng dùng catalog và thực đơn

- Khám phá catalog công khai không cần hồ sơ. Chỉ công thức có nguyên liệu
  đã xác minh Vegetarian ALLOWED mới xuất hiện; công thức chứa UNKNOWN,
  FORBIDDEN hoặc chưa có nguyên liệu trả 404 ở API detail.
- `GET /recipes?veganOnly=true` chỉ trả công thức có tất cả nguyên liệu VEGAN
  và không có nhãn động vật. `veganStatus` của công thức là
  `VERIFIED_VEGAN | NON_VEGAN | UNKNOWN`, do server tính.
- `suitableForMe=true` cần login và readyForMealPlanning. Áp dụng chế độ ăn,
  loại trừ, Ingredient active, compositionComplete và quy tắc xung đột
  trước khi phân trang/đếm. Hồ sơ Vegan chỉ nhận VERIFIED_VEGAN.
- Khi profile có ALLERGY, món có bất kỳ Ingredient allergensComplete=false
  cũng bị loại. Nhãn ALLERGEN kiểm tra cả allergenLabels và mayContainAllergens.
- Gợi ý Meal Planner dùng cùng điều kiện. Chat planner yêu cầu hồ sơ đầy đủ
  trước khi gọi AI; tool giữ version ở đầu lượt, từ chối khi profile đã đổi.
- Recipe detail bổ sung cho mỗi nguyên liệu: allergenLabels,
  mayContainAllergens, allergensComplete, compositionComplete, active,
  safetyVersion. Thông tin này cần được đọc cùng ghi chú công thức; không
  hiển thị cam kết món hoàn toàn an toàn.

POST /meal-plan/preview thêm `dietaryVersion`. GET/PUT meal-plan trả thêm
`dietaryVersion` và `status=VALID|NEEDS_REVIEW`. Đây là version hiện tại được
dùng để đánh giá, không phải lịch sử phiên bản của kế hoạch.

Các problem code mới:

| Code                            | FE hiển thị                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------- |
| DIETARY_PROFILE_INCOMPLETE      | Cần xác nhận thông tin dị ứng                                                   |
| UNVERIFIED_INGREDIENT           | Thành phần chưa xác minh, thiếu composition, inactive hoặc không phù hợp chế độ |
| ALLERGEN_INFORMATION_INCOMPLETE | Không đủ thông tin dị ứng                                                       |
| AVOIDED_INGREDIENT              | Thành phần/nhãn/may-contain nằm trong loại trừ                                  |

Các code cũ UNKNOWN_RECIPE và DAY_CONFLICT vẫn dùng. Kế hoạch cũ giữ nguyên
món, được đánh giá lại khi đọc, hiện NEEDS_REVIEW nếu có vấn đề. Không tự
thay/xóa món sau khi sửa profile hoặc phân loại Ingredient.

Lưu thực đơn luôn kiểm tra lại trong transaction; profile update và save
dùng khóa cùng User. Thay đổi đồng thời có thể trả 409 MEAL_PLAN_CHANGED:
đọc lại hồ sơ/thực đơn, preview lại, để người dùng áp dụng lại. Tác vụ chỉ
xóa bớt món, giữ thứ tự và bữa của món còn lại được phép sửa kế hoạch không
hợp lệ; di chuyển/thêm/sắp xếp lại hoặc gửi nguyên nội dung vẫn cần kiểm tra.

## Lỗi và phục hồi

| HTTP / code                                      | Xử lý                                                                      |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| 401                                              | Yêu cầu đăng nhập/refresh token                                            |
| 400 INVALID_ALLERGY_ACKNOWLEDGEMENT              | Chọn xác nhận phù hợp với ALLERGY exclusions                               |
| 400 INVALID_EXCLUSION_TARGET / UNKNOWN_REFERENCE | Đọc lại options, sửa target                                                |
| 400 CONFLICTING_PREFERENCE                       | Loại một lựa chọn thích hoặc lựa chọn loại trừ                             |
| 400 EMPTY_UPDATE                                 | Chỉ gửi request khi có field thay đổi                                      |
| 409 VERSION_CONFLICT                             | GET profile mới, giữ bản nhập, cho người dùng rà thay đổi; không tự ghi đè |
| 409 DIETARY_PROFILE_INCOMPLETE                   | Mở phần xác nhận hồ sơ trước khi gợi ý/tạo thực đơn                        |
| 409 DIETARY_PROFILE_CHANGED                      | Tạo lượt đề xuất mới theo hồ sơ hiện tại                                   |
| 409 MEAL_PLAN_INVALID                            | Hiển thị problems, giữ thực đơn đang lưu                                   |
| 409 MEAL_PLAN_CHANGED                            | Đọc lại và preview lại trước khi thử lưu                                   |

Khi profile update thành công, làm mới catalog suitableForMe và thực đơn;
không giữ kết quả của tài khoản/profile version cũ.

## API PUT cũ

```json
{
  "expectedVersion": 0,
  "ingredientIds": [],
  "groupIds": [],
  "likedIngredientIds": []
}
```

PUT chỉ thay PERSONAL, giữ ALLERGY và DIET; không thể xác nhận dị ứng hoặc
đổi chế độ. Frontend hồ sơ mới dùng PATCH. Client cũ phải bổ sung
expectedVersion; request thiếu field này trả 400.

## Admin: phân loại nguyên liệu

POST/PUT `/admin/ingredients` giữ name/aliases/groupIds hiện có và nhận:
active, vegetarianStatus (ALLOWED/FORBIDDEN/UNKNOWN), veganStatus
(VEGAN/NON_VEGAN/UNKNOWN), animalLabels, allergenLabels,
mayContainAllergens, compositionComplete, allergensComplete,
classificationSource, classificationReason.

Nếu gửi bất kỳ field safety nào, phải gửi nguồn và lý do không rỗng.
PUT thay safety cần thêm expectedSafetyVersion; conflict trả 409
VERSION_CONFLICT. Safety fields bỏ qua trên PUT được giữ nguyên; name,
aliases, groupIds vẫn theo hợp đồng thay thế trước đây. Không gửi null.

Response Admin trả các field này và safetyVersion. Một lần cập nhật safety
thành công tăng safetyVersion. Không chấp nhận VEGAN có nhãn động vật hoặc
không ALLOWED; không chấp nhận ALLOWED có nhãn từ giết mổ; allergensComplete
chỉ true khi compositionComplete=true.

Ingredient còn tham chiếu trong Recipe hoặc hồ sơ không xóa cứng, trả 409
INGREDIENT_IN_USE; dùng active=false. Group còn trong hồ sơ trả 409 GROUP_IN_USE.
Ingredient inactive có thể giữ trong công thức công khai để đọc lịch sử,
nhưng không được gợi ý/lập thực đơn mới. Chuyển FORBIDDEN/UNKNOWN làm công thức
không còn trong catalog công khai; kế hoạch riêng vẫn giữ và báo vấn đề.

## Migration và phạm vi

Migration `20261012010000_dietary_profile` cần chạy trước API mới và generate
Prisma Client khi build. Nó giữ mọi loại trừ cũ với lý do PERSONAL, giữ liked,
không tự gán ALLERGY hoặc NONE_DECLARED. Ingredient cũ mặc định UNKNOWN và
composition/allergensComplete=false. **Catalog cũ chưa phân loại sẽ bị ẩn;
Admin cần bổ sung dữ liệu đã xác minh trước khi đưa nhánh này vào sử dụng.**
Không tự suy luận/seed nhãn theo tên nguyên liệu.

Nhánh này triển khai hồ sơ và điều kiện phù hợp cho catalog/thực đơn hiện có.
Meal Planner vẫn là tuần MON–SUN; kế hoạch có ngày, số người, phiên bản khôi
phục và trình tạo theo quy tắc sẽ triển khai riêng. Recommendation, durable
AI jobs/quota, consent và quy trình kiểm duyệt đầy đủ theo SRS cũng chưa thuộc
task này. Kiểm tra allergenLabels không thay thế kiểm tra nhãn hàng thực tế
và không bảo đảm tránh nhiễm chéo.
