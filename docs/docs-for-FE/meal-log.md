# Nhật ký ăn uống (meal log)

Ghi lại **món đã thực sự ăn**, tách khỏi thực đơn (món _dự định_ ăn). Dùng để theo dõi kcal trong ngày, xem thống kê tuần và để trợ lý chỉnh các ngày còn lại.

Mọi endpoint cần đăng nhập (`Authorization: Bearer`), chỉ đọc/sửa nhật ký của chính mình.

## Quy tắc nghiệp vụ

| Quy tắc        | Chi tiết                                                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ngày được ghi  | Hôm nay và `MEAL_LOG_EDITABLE_DAYS` (mặc định 7) ngày trước. Ngày tương lai hoặc cũ hơn → `409 MEAL_LOG_LOCKED`. Sửa/xoá món của ngày đã khoá cũng bị `409 MEAL_LOG_LOCKED`.                                                                               |
| Nguồn món      | Gửi **đúng một** trong `recipeId` (món trong catalog) hoặc `name` (món ngoài). API tự gắn `source`: `PLAN` nếu món có trong thực đơn đúng bữa hôm đó, `RECIPE` nếu không, `CUSTOM` cho món ngoài.                                                          |
| Trùng món      | Một công thức chỉ ghi một lần mỗi bữa (`409 CONFLICT`); ăn thêm thì tăng `servings`. Món ngoài không giới hạn trùng tên.                                                                                                                                   |
| Số món mỗi bữa | Tối đa `MEAL_LOG_MAX_ENTRIES_PER_MEAL` (mặc định 10) → `409 MEAL_LOG_FULL`.                                                                                                                                                                                |
| Khẩu phần      | `servings` 0.25–20, tối đa 2 chữ số thập phân, mặc định 1.                                                                                                                                                                                                 |
| Kcal           | `caloriesPerServing` là số nguyên 0–5000 cho **một** khẩu phần; `calories` = `caloriesPerServing × servings` (làm tròn). Món công thức lấy kcal của công thức lúc ghi (`calorieSource: RECIPE`); người dùng có thể ghi đè. Món ngoài có thể để trống kcal. |
| Nguồn kcal     | `RECIPE` (chỉ API gắn), `USER` (tự nhập, mặc định khi gửi kcal), `WEB_ESTIMATE` (AI tra web). `calorieReferences` chỉ được giữ với `WEB_ESTIMATE`.                                                                                                         |
| Đổi tên        | Chỉ món `CUSTOM`; món công thức giữ tên công thức → `400`.                                                                                                                                                                                                 |
| Xoá công thức  | Nhật ký giữ nguyên tên và kcal đã chép, chỉ `recipeId` thành `null`.                                                                                                                                                                                       |

**Hiển thị:** kcal `WEB_ESTIMATE` là ước tính — hiện kèm "~" và nhãn "AI ước tính", có nguồn. Không dùng màu đỏ/xanh hay chữ "vượt"; nói "còn lại".

## `GET /meal-plan/log?weekStart=YYYY-MM-DD`

`weekStart` (thứ Hai) không bắt buộc, mặc định tuần hiện tại. `Cache-Control: private, no-store`.

```json
{
  "weekStart": "2026-11-23",
  "today": "2026-11-25",
  "dailyCalorieTarget": 1800,
  "dailyCalorieMin": 1600,
  "dailyCalorieMax": 2000,
  "days": [
    {
      "day": "MON",
      "date": "2026-11-23",
      "loggable": true,
      "entries": [
        {
          "id": "…",
          "date": "2026-11-23",
          "section": "LUNCH",
          "source": "PLAN",
          "recipeId": "…",
          "name": "Đậu hũ sốt cà",
          "servings": 1.5,
          "caloriesPerServing": 300,
          "calories": 450,
          "calorieSource": "RECIPE",
          "calorieNote": null,
          "calorieReferences": [],
          "createdAt": "2026-11-23T05:10:00.000Z"
        }
      ],
      "loggedCalories": 450,
      "unknownCalorieEntries": 0,
      "plannedCalories": 1650
    }
  ],
  "summary": {
    "loggedDays": 2,
    "completeDays": 1,
    "averageCalories": 1720,
    "remainingDays": 5
  }
}
```

- `days`: đủ 7 ngày, thứ Hai trước; `entries` xếp theo bữa (Sáng, Trưa, Tối, Khác) rồi theo giờ ghi.
- `loggable`: ngày còn ghi/sửa được.
- `loggedCalories`: tổng các món đã biết kcal; `unknownCalorieEntries`: số món chưa có kcal (khi > 0, hiện tổng là "ít nhất …").
- `plannedCalories`: tổng kcal thực đơn của ngày; `null` khi ngày trống.
- `dailyCalorie*`: từ Hồ sơ dinh dưỡng; `null` khi chưa khai báo.
- `summary.loggedDays`: số ngày (đến hôm nay) có ít nhất một món.
- `summary.completeDays` / `averageCalories`: chỉ tính **ngày đã qua** mà mọi món đều có kcal (hôm nay chưa hết ngày; món chưa rõ kcal làm số thấp đi). `averageCalories` là `null` khi chưa có ngày nào như vậy.
- `summary.remainingDays`: số ngày từ hôm nay đến Chủ nhật (thực đơn còn chỉnh được).

## `POST /meal-plan/log` → `201` một entry

```json
{ "date": "2026-11-25", "section": "LUNCH", "recipeId": "…", "servings": 1 }
```

```json
{
  "date": "2026-11-25",
  "section": "LUNCH",
  "name": "Bún riêu chay",
  "servings": 1,
  "caloriesPerServing": 450,
  "calorieSource": "WEB_ESTIMATE",
  "calorieNote": "Tô vừa ~500 g",
  "calorieReferences": [{ "title": "…", "url": "https://…" }]
}
```

## `PATCH /meal-plan/log/:id` → `200` entry

Các field đều tuỳ chọn: `section`, `servings`, `name` (chỉ CUSTOM), `caloriesPerServing` (`null` xoá kcal cùng nguồn/ghi chú), `calorieSource` (`USER` | `WEB_ESTIMATE`, mặc định `USER` khi gửi kcal), `calorieNote`, `calorieReferences`.

## `DELETE /meal-plan/log/:id` → `204`

## `POST /meal-plan/log/calorie-estimate` → `200`

Nút "AI tìm kcal": AI tra web (OpenRouter web search) và trả ước tính cho **một khẩu phần**. **Không lưu gì**; người dùng xem, sửa nếu cần, rồi gửi kèm khi ghi món với `calorieSource: "WEB_ESTIMATE"`.

```json
{ "name": "Bún riêu chay", "details": "Tô lớn ở quán, thêm đậu hũ chiên" }
```

```json
{
  "caloriesPerServing": 520,
  "note": "Tô lớn ~600 g gồm bún, đậu hũ chiên, cà chua; ước tính theo bảng thành phần Viện Dinh dưỡng.",
  "references": [{ "title": "…", "url": "https://…" }]
}
```

- `caloriesPerServing` là `null` khi không tìm được số đủ tin cậy: cho người dùng tự nhập.
- Tính vào hạn mức AI văn bản dùng chung với trợ lý thực đơn: hết hạn mức → `429 AI_QUOTA_EXCEEDED`; gọi dồn dập → `429 TOO_MANY_REQUESTS`; nhà cung cấp AI lỗi → `503`. Có thể mất tới `MEAL_LOG_CALORIE_ESTIMATE_TIMEOUT_MS` (mặc định 50 giây): hiện trạng thái đang tìm và cho huỷ.

## Trợ lý thực đơn

Planner có tool `getEatingLog` (chỉ đọc). Trợ lý không ghi nhật ký thay người dùng.

Nút **"Nhờ trợ lý xem lại tuần"** trong sheet Nhật ký chỉ hiện khi `summary.completeDays ≥ 1` và `summary.remainingDays > 0`. Nút gửi vào chat một câu ghi rõ phạm vi ngày, ví dụ:

> Xem nhật ký ăn uống tuần này và nhận xét ngắn so với kế hoạch và mục tiêu của mình. Nếu nên chỉnh thực đơn thì hỏi mình trước; khi chỉnh, chỉ từ hôm nay (T3 24/11) đến CN 29/11, không đụng tuần khác.

Trợ lý nhận xét trước, hỏi bằng `askUser` rồi mới sửa. Chỉ sửa từ hôm nay đến Chủ nhật của tuần đó (ngày đã qua bị API khoá bằng `MEAL_DAY_LOCKED`). Mỗi ngày lệch tối đa ~10–15% quanh mục tiêu, không dưới ~1.200 kcal, không khuyên nhịn hay "ăn bù".
