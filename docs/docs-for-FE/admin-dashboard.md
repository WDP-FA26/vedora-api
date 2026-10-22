# Dashboard quản trị

`GET /api/v1/admin/dashboard?from=2026-10-01&to=2026-10-23`

Bearer token của ADMIN đang ACTIVE. Không đăng nhập trả 401; Member trả 403.
Role/status được lấy từ account hiện tại, không tin role claim trong JWT.
Response dùng `Cache-Control: private, no-store` và `Vary: Authorization`.

## Khoảng ngày

- Chỉ nhận `from`, `to`, định dạng chính xác YYYY-MM-DD và phải là ngày hợp lệ.
- Nếu truyền thì phải truyền cả hai. `from <= to`, tối đa **90 ngày tính cả hai đầu**.
- Nếu bỏ cả hai: 30 ngày, kết thúc vào hôm nay theo **Asia/Bangkok (UTC+7)**.
- Mốc DB là `[00:00 ngày from, 00:00 ngày sau to)`, đổi rõ sang UTC; không dựa
  vào timezone của Node/container/PostgreSQL. Ví dụ ngày 01/10/2026 bắt đầu tại
  `2026-09-30T17:00:00Z`.
- Ngày chưa có dữ liệu vẫn có một row với count 0. Khoảng ngày trong tương lai
  hợp lệ vẫn trả các count thực tế, thường là 0; không thay đổi snapshot hiện tại.
- Partial/reversed/range >90 ngày trả 400 (service dùng INVALID_DASHBOARD_RANGE).
  Timestamp, query lặp, timezone/userId/include hay field lạ cũng bị 400.

## Response và nghĩa số liệu

```json
{
  "generatedAt": "2026-10-23T05:00:00.000Z",
  "range": { "from": "2026-10-01", "to": "2026-10-23", "dayCount": 23, "timeZone": "Asia/Bangkok" },
  "snapshot": {
    "members": { "total": 20, "active": 16, "suspended": 1, "pendingEmail": 3 },
    "pendingReports": 2
  },
  "period": {
    "newMembers": 5,
    "publishedContent": { "posts": 8, "blogs": 2, "total": 10 },
    "recipesCreated": 4,
    "reportsCreated": 3,
    "reportDecisions": { "resolved": 1, "dismissed": 1, "total": 2 }
  },
  "daily": [
    { "date": "2026-10-01", "newMembers": 0, "publishedPosts": 0, "publishedBlogs": 0, "reportsCreated": 0, "resolvedReports": 0, "dismissedReports": 0 }
  ],
  "unavailableMetrics": ["MODERATION_CASE_SEVERITY", "CONTENT_APPROVALS", "PAYMENT_DEMO"]
}
```

Ví dụ rút gọn `daily`; response thật luôn đủ dayCount ngày, tăng dần, và tổng
daily khớp các count tương ứng trong period.

| Nhóm | Cách tính |
| --- | --- |
| snapshot.members | Account role USER hiện tại, loại DELETED. Không gồm ADMIN, không lọc ngày, không phải số liệu lịch sử tại ngày to |
| snapshot.pendingReports | Tất cả PostReport hiện PENDING, kể cả được tạo ngoài kỳ |
| period.newMembers | USER còn tồn tại, chưa DELETED, có createdAt trong kỳ; có thể đang PENDING_EMAIL/SUSPENDED |
| period.publishedContent | Post hiện PUBLISHED, publishedAt trong kỳ, nhóm POST/BLOG. POST gồm bài có video. Không đếm DRAFT/PROCESSING/FAILED |
| period.recipesCreated | Recipe catalog còn tồn tại, createdAt trong kỳ. Không phải số Recipe Approved, không lọc phù hợp hồ sơ cá nhân |
| period.reportsCreated | PostReport có createdAt trong kỳ, bất kể trạng thái xử lý hiện tại |
| period.reportDecisions | PostReport RESOLVED/DISMISSED, reviewedAt trong kỳ, kể cả report được tạo trước kỳ. Không phải quyết định duyệt nội dung |

Các thống kê mô tả **bản ghi hiện còn**, không khôi phục snapshot quá khứ. Xóa
cứng user/post/report/recipe hoặc chuyển Blog về nháp có thể làm số liệu kỳ cũ
thay đổi. Public post gate hiện là PUBLISHED, giống feed hiện tại; không bổ sung
quy trình approval/hidden/safety hay thay đổi nội dung của module khác.

## Chỉ số chưa có nguồn

- MODERATION_CASE_SEVERITY: chưa có nguồn case với mức độ severity.
- CONTENT_APPROVALS: chưa có nguồn submission/decision của luồng duyệt nội dung.
- PAYMENT_DEMO: chưa nối nguồn PaymentDemo succeeded và tổng tiền mô phỏng.

FE hiển thị **“Chưa có dữ liệu”**, không dùng 0, không suy severity từ reason,
không lấy quyết định xử lý report thay cho approval hoặc coi PUBLISHED là Approved.
Thanh toán phải ghi rõ **mô phỏng**. Phần này không sửa task moderation/payment
đang do người khác thực hiện; Dashboard chưa phải toàn bộ metric của REQ-ADM-03.

## Tích hợp và kiểm thử

FE tại `/admin/insights`, dùng schema response, cache theo token + khoảng ngày,
không tải toàn bộ danh sách user/bài đăng để tính tổng ở browser. Bộ lọc phải có
Apply, giữ số đã áp dụng rõ ràng, có loading/error/empty state và nút refresh.

BE chỉ đọc, dùng RepeatableRead cho snapshot + period. Aggregate SQL gom theo
ngày tại DB, không query từng ngày, không trả email, ID user, nội dung post hoặc
dữ liệu chat/dietary/meal-plan. Không có migration, provider AI, Redis/BullMQ mới.

```powershell
npm run build
npm run lint
npm test -- src/admin-dashboard/dashboard-range.spec.ts
npm run test:e2e -- test/admin-dashboard.e2e-spec.ts
$env:TEST_DATABASE_URL = "postgresql://user:password@localhost:5432/vedora_test"
npm run test:db -- test/admin-dashboard.db-spec.ts
```

DB suite tạo schema ngẫu nhiên trong database test và kiểm tra mốc UTC+7, enum,
role/status thật, zero-fill, 90 ngày, privacy và không thay đổi domain records.
