# Danh sách mua sắm từ thực đơn tuần

`GET /api/v1/meal-plan/shopping-list`, Bearer token bắt buộc.
Chỉ đọc thực đơn của người gọi, kể cả Admin; không nhận `userId` và không thay
đổi/lưu thực đơn, hồ sơ hoặc trạng thái đã mua. Response: `Cache-Control: private, no-store`.

## Lọc ngày

Mặc định cả tuần MON–SUN. Chọn ngày bằng một trong hai dạng:

```http
GET /api/v1/meal-plan/shopping-list?days=MON,TUE
GET /api/v1/meal-plan/shopping-list?days=MON&days=TUE
Authorization: Bearer <accessToken>
```

Ngày phải viết hoa, không trùng; chuỗi rỗng, ngày lạ, hơn 7 giá trị hoặc field
không hỗ trợ trả 400. Response luôn sắp `days` từ MON đến SUN, không theo thứ tự
query. Thực đơn rỗng/ngày chưa có món trả `items: []`.

## Quy tắc định lượng

Mỗi lần công thức xuất hiện trong một ngày/bữa tính **đủ định lượng gốc của công
thức một lần**, kể cả cùng công thức nằm ở nhiều ngày/bữa. Có tính cả OTHER.
Không nhân số người, không chia theo servings, không trừ nguyên liệu đang có.
`quantityBasis = "RECIPE_PER_OCCURRENCE"` và `servings` trên nguồn giúp FE giải
thích đây là lượng cho cả công thức, không phải lượng cho một người.

- Cộng bằng Decimal theo cùng `ingredientId` và cùng đơn vị. Không gộp hai ID
  chỉ vì giống tên; không đổi g/kg/ml/cái hoặc cộng chéo các đơn vị.
- Đơn vị được trim hai đầu; chuỗi rỗng và null là chưa xác định, trả `unit=null`.
  Ngoài trim, giữ nguyên đơn vị, kể cả chữ hoa/thường.
- `knownQuantity` là tổng phần có định lượng, dạng chuỗi Decimal hai chữ số lẻ.
  Nếu mọi nguồn đều quantity=null thì tổng cũng null, không đổi thành 0.
- `hasUnknownQuantity=true` nghĩa là còn ít nhất một nguồn chưa có định lượng.
  Khi đó `knownQuantity` chỉ là **phần đã biết**, không phải tổng đầy đủ.
- Giữ từng `contributions` gồm món/ngày/bữa, quantity và note để người dùng kiểm
  tra/bổ sung. Không suy đoán lượng còn thiếu bằng AI.

## Response HTTP 200

```json
{
  "days": ["MON"],
  "quantityBasis": "RECIPE_PER_OCCURRENCE",
  "items": [
    {
      "ingredientId": "a1a2d3e4-0000-4000-8000-000000000001",
      "name": "Đậu hũ",
      "unit": "g",
      "knownQuantity": "100.25",
      "hasUnknownQuantity": true,
      "contributions": [
        {
          "recipeId": "d1a2d3e4-0000-4000-8000-000000000001",
          "recipeTitle": "Đậu hũ sốt cà",
          "day": "MON",
          "section": "LUNCH",
          "servings": 2,
          "quantity": "100.25",
          "note": "cắt nhỏ"
        },
        {
          "recipeId": "d1a2d3e4-0000-4000-8000-000000000002",
          "recipeTitle": "Canh đậu hũ",
          "day": "MON",
          "section": "DINNER",
          "servings": 4,
          "quantity": null,
          "note": "thêm tùy khẩu vị"
        }
      ]
    }
  ]
}
```

FE có thể hiển thị ví dụ trên là “100.25 g đã biết + phần chưa định lượng”, mở
nguồn bằng recipeId và phân biệt từng ngày/bữa. Các item sắp theo tên Việt, rồi
ingredientId/đơn vị. Nguồn sắp theo ngày, bữa và thứ tự món trong thực đơn.

API đọc lịch và nguyên liệu trong cùng RepeatableRead snapshot, tránh ghép lịch
cũ với định lượng mới khi có chỉnh sửa đồng thời. Dùng dữ liệu Recipe hiện tại,
không phải snapshot lịch sử. Chức năng này là mở rộng được giao riêng, không đổi
Meal Planner tuần hiện có thành mô hình có ngày/thay đổi số người của SRS.

| HTTP | Trường hợp |
| --- | --- |
| 400 | Bộ lọc ngày/query sai hoặc field lạ |
| 401 | Thiếu/sai token hoặc account không còn |

Không cần migration, seed hoặc provider AI. Test HTTP:
`npm run test:e2e -- test/shopping-list.e2e-spec.ts`.
Test PostgreSQL dùng TEST_DATABASE_URL của database test riêng:
`npm run test:db -- test/shopping-list.db-spec.ts`.
