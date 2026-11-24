# Báo cáo bình luận vi phạm

## Phạm vi

Thành viên đã đăng nhập có thể báo cáo bình luận gốc hoặc phản hồi của người khác trên bài viết đang công khai. Báo cáo được chuyển vào hàng đợi riêng của admin; không tự động xóa nội dung hoặc gọi AI kiểm duyệt lại. Bình luận của tài khoản hệ thống cũng có thể được báo cáo.

Mỗi tài khoản chỉ gửi một báo cáo cho một bình luận, kể cả khi báo cáo trước đã xử lý. Các thành viên khác vẫn có thể báo cáo cùng bình luận.

## API

### Gửi báo cáo

`POST /api/v1/posts/:postId/comments/:commentId/report`

Yêu cầu Bearer token. UUID của bình luận phải thuộc đúng bài viết; bài viết phải có trạng thái `PUBLISHED`.

```json
{ "reason": "HARASSMENT", "details": "Nội dung cần admin kiểm tra" }
```

`reason` dùng cùng danh sách với báo cáo bài viết: `SPAM`, `HARASSMENT`, `MISINFORMATION`, `HARMFUL_ADVICE`, `INAPPROPRIATE`, `NOT_PLANT_BASED`, `OTHER`. `details` không bắt buộc, được trim, giới hạn theo `REPORT_MAX_DETAILS_LENGTH` (mặc định 500).

Trả `201` với `{ id, postId, commentId, reason, details, status, createdAt }`; không trả người báo cáo, bằng chứng hay danh tính admin. Không có API công khai để đọc báo cáo của người khác.

Lỗi: `400 OWN_COMMENT` khi tự báo cáo; `409 ALREADY_REPORTED` khi trùng; `404 NOT_FOUND` khi nội dung không tồn tại/không khả dụng hoặc bình luận thuộc bài khác. UUID, reason, độ dài, thuộc tính lạ được validation theo hợp đồng chung. Tài khoản bị đình chỉ bị chặn theo cơ chế xác thực hiện có.

### Hàng đợi admin

`GET /api/v1/admin/comment-reports?page=1&limit=20&status=PENDING`

Chỉ role `ADMIN`. Phân trang theo hợp đồng `PaginatedResponseDto`, sắp xếp mới nhất trước, có `_id` để ổn định thứ tự. `status` tùy chọn: `PENDING`, `RESOLVED`, `DISMISSED`. Giới hạn trang dùng cấu hình pagination hiện có.

Mỗi dòng có thông tin receipt cùng:

- `comment`: `id`, `parentId`, `body` tại lúc báo cáo, `author` tại lúc báo cáo, `currentBody`, `isAvailable`, `replyCount` hiện tại.
- `reporter`: thông tin người báo cáo hoặc `null` nếu tài khoản không còn.
- `postAvailable`: bài viết hiện có còn công khai không.
- `action`, `reviewedById`, `reviewedAt`: kết quả và dấu vết xử lý, ban đầu `null`.

UI hiển thị cả nội dung lúc báo cáo và nội dung hiện tại nếu khác nhau. Chỉ tạo liên kết tới `/posts/:postId?comment=:commentId#comment-:commentId` khi bài viết và bình luận còn khả dụng.

### Quyết định của admin

`POST /api/v1/admin/comment-reports/:id/review`

```json
{ "action": "REMOVE" }
```

| Yêu cầu | Kết quả |
| --- | --- |
| `DISMISS` | `DISMISSED`, action `DISMISSED`; giữ nguyên nội dung, chỉ đóng báo cáo được chọn. |
| `REMOVE`, bình luận còn tồn tại | `RESOLVED`, action `REMOVED`; xóa bình luận và đóng các báo cáo đang chờ của nội dung bị xóa. |
| `REMOVE`, bình luận đã bị xóa | `RESOLVED`, action `ALREADY_REMOVED`; đóng các báo cáo đang chờ của bình luận đó và giữ bằng chứng. |

Trả `200` với một `AdminCommentReportDto` mới nhất. Báo cáo không tồn tại trả `404`; đã được xử lý trả `409 CONFLICT`; người dùng thường trả `403`. Sau quyết định cần đọc lại trang danh sách, vì xóa một bình luận có thể hoàn tất nhiều báo cáo.

Gỡ bình luận gốc xóa toàn bộ trả lời. Gỡ một phản hồi giữ bình luận gốc và các phản hồi khác, đồng thời xóa các thông báo liên quan và bỏ các tham chiếu reply-to trỏ tới nội dung bị xóa. UI phải xác nhận thao tác không hoàn tác được.

## Nhất quán và lưu bằng chứng

Collection mới: `comment_reports`, có unique index `(commentId, reporterId)`. Các trường snapshot không thay đổi khi tác giả sửa/xóa nội dung; báo cáo vẫn có thể được admin đọc sau khi bài viết hoặc tài khoản tác giả bị xóa. Đây là dữ liệu chỉ dành cho admin, không trả qua API bình luận.

Ghi báo cáo chụp bằng chứng trong transaction. Quyết định gỡ nội dung, cascade và cập nhật những báo cáo liên quan cũng nằm trong cùng transaction. Dùng khóa tài khoản và write fence của bài viết để phối hợp với đình chỉ tài khoản, sửa, trả lời và xóa. Hai admin xử lý cùng báo cáo chỉ một quyết định được ghi; lỗi giữa chừng rollback toàn bộ thao tác.

## Triển khai và kiểm thử

Triển khai BE trước FE. MongoDB cần replica set theo cấu hình dự án để chạy transaction. Mongoose đăng ký collection/index khi khởi động; không cần migration Prisma hay biến env mới.

Kiểm thử HTTP với MongoDB thật:

```sh
npx vitest run --config vitest.config.e2e.mts test/e2e/comment-reports.e2e-spec.ts
```

Bao phủ phân quyền, validation, tự báo cáo, association sai, nội dung ẩn, receipt riêng tư, trim và snapshot, gửi trùng đồng thời, phân trang, bỏ qua, xóa phản hồi/cả luồng, bằng chứng sau khi xóa, race giữa các admin, rollback và race với xóa thường.

### Kết quả xác minh ngày 24/11/2026

- `npm run build` và `npm run lint`: pass, kể cả sau khi đồng bộ main `b36ec9b`.
- 16 kiểm thử HTTP mới và 93 kiểm thử hồi quy post interactions: pass với MongoDB replica set trong Docker.
- 34 unit test hiện có của interactions, admin reports và Mongo helpers: pass.
- Image production Docker build thành công. Smoke test gọi API trong container bằng tài khoản fixture, xác nhận 401/403, receipt 201, chống trùng 409, admin đọc hàng đợi, gỡ cả luồng trong transaction, đóng báo cáo liên quan và giữ bằng chứng.
- Provider credentials trong smoke test là placeholder cục bộ; luồng báo cáo không gọi AI hoặc gửi email.
