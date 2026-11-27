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

- `comment`: `id`, `parentId`, `body` tại lúc báo cáo, `author` tại lúc báo cáo, `currentBody`, `isAvailable`, `replyCount` hiện tại, `isEdited` và `currentVersion`.
- `reportCount`, `pendingReportCount`, `resolvedReportCount`, `dismissedReportCount`: tổng lượt và số lượt theo trạng thái của **cả bình luận**, kể cả các receipt nằm ngoài trang hoặc bộ lọc hiện tại.
- `reporter`: thông tin người báo cáo hoặc `null` nếu tài khoản không còn.
- `postAvailable`: bài viết hiện có còn công khai không.
- `action`, `reviewedById`, `reviewedAt`: kết quả và dấu vết xử lý, ban đầu `null`.

API vẫn phân trang từng receipt; `meta.totalItems` là số receipt thỏa bộ lọc. FE đọc toàn bộ các trang không lọc trạng thái, gom theo `commentId` rồi mới lọc, sắp xếp và phân trang bảng. Mỗi bình luận có một dòng cùng tổng lượt và số chờ xử lý; hai bình luận có cùng nội dung vẫn là hai dòng riêng. Một nhóm có thể xuất hiện trong nhiều tab nếu có các receipt mang trạng thái khác nhau.

Chi tiết nhóm hiển thị từng người báo cáo, thời điểm, lý do, mô tả, bằng chứng và kết quả riêng; phía trên là nội dung hiện tại và cảnh báo đã sửa. Nút bỏ qua nhanh trên bảng chỉ có khi còn đúng một receipt chờ; nếu nhiều receipt, admin mở chi tiết để bỏ qua từng lượt. Gỡ nội dung sẽ đóng toàn bộ receipt chờ liên quan.

Chỉ tạo liên kết tới `/posts/:postId?comment=:commentId#comment-:commentId` khi bài viết và bình luận còn khả dụng.

### Quyết định của admin

`POST /api/v1/admin/comment-reports/:id/review`

```json
{
  "action": "REMOVE",
  "expectedCommentVersion": "<currentVersion gồm 64 ký tự từ bản xem trước>"
}
```

| Yêu cầu | Kết quả |
| --- | --- |
| `DISMISS` | `DISMISSED`, action `DISMISSED`; giữ nguyên nội dung, chỉ đóng báo cáo được chọn. |
| `REMOVE`, bình luận còn tồn tại | `RESOLVED`, action `REMOVED`; xóa bình luận và đóng các báo cáo đang chờ của nội dung bị xóa. |
| `REMOVE`, bình luận đã bị xóa | `RESOLVED`, action `ALREADY_REMOVED`; đóng các báo cáo đang chờ của bình luận đó và giữ bằng chứng. |

Trả `200` với một `AdminCommentReportDto` mới nhất. Báo cáo không tồn tại trả `404`; đã được xử lý trả `409 CONFLICT`; người dùng thường trả `403`. Sau quyết định cần đọc lại trang danh sách, vì xóa một bình luận có thể hoàn tất nhiều báo cáo.

`DISMISS` chỉ cần `{ "action": "DISMISS" }`. Với `REMOVE`, FE phải gửi `expectedCommentVersion` lấy từ `comment.currentVersion` trong bản xem trước; bình luận đã xóa dùng `null`. Thiếu trường này trả `400 BAD_REQUEST`. Chuỗi không đúng 64 ký tự bị validation từ chối.

Nếu tác giả sửa hoặc xóa bình luận sau bản xem trước, BE trả `409 COMMENT_CHANGED` và rollback, không gỡ nội dung, đóng receipt hay gửi thông báo. FE đóng hộp xác nhận, tải lại dữ liệu và yêu cầu admin xem nội dung mới rồi xác nhận lần nữa. FE giữ nguyên phiên bản lúc mở xác nhận dù dữ liệu nền được cập nhật; không tự gửi lại thao tác gỡ sau xung đột.

Gỡ bình luận gốc xóa toàn bộ trả lời. Gỡ một phản hồi giữ bình luận gốc và các phản hồi khác, đồng thời xóa các thông báo liên quan và bỏ các tham chiếu reply-to trỏ tới nội dung bị xóa. UI phải xác nhận thao tác không hoàn tác được.

## Nhất quán và lưu bằng chứng

Collection mới: `comment_reports`, có unique index `(commentId, reporterId)`. Các trường snapshot không thay đổi khi tác giả sửa/xóa nội dung; báo cáo vẫn có thể được admin đọc sau khi bài viết hoặc tài khoản tác giả bị xóa. Đây là dữ liệu chỉ dành cho admin, không trả qua API bình luận.

Receipt mới lưu thêm `commentVersionSnapshot`, dấu SHA-256 của ID, nội dung và `updatedAt` bình luận. Admin DTO trả phiên bản hiện tại dưới dạng opaque token `currentVersion`; `isEdited` cho biết khác phiên bản lúc báo cáo. Không dùng token này làm thông tin xác thực. Các thay đổi bộ đếm nội bộ do báo cáo hoặc trả lời không đổi phiên bản nội dung. Receipt cũ không có dấu phiên bản vẫn đọc được, dùng so sánh `bodySnapshot` với nội dung hiện tại để nhận biết đã sửa; không cần backfill. Sửa bình luận không đặt lại số lượt hay cho phép báo cáo lần hai.

Ghi báo cáo chụp bằng chứng trong transaction. Quyết định gỡ nội dung, cascade và cập nhật những báo cáo liên quan cũng nằm trong cùng transaction. Dùng khóa tài khoản và write fence của bài viết để phối hợp với đình chỉ tài khoản, sửa, trả lời và xóa. Hai admin xử lý cùng báo cáo chỉ một quyết định được ghi; lỗi giữa chừng rollback toàn bộ thao tác.

## Triển khai và kiểm thử

Thông báo cho tác giả/người báo cáo khi xử lý bình luận được mô tả trong [comment-notifications.md](./comment-notifications.md). Phần thông báo có yêu cầu phát hành FE hỗ trợ enum mới trước BE.

Phát hành đồng bộ BE và FE của thay đổi gom báo cáo/kiểm tra phiên bản: client cũ không gửi `expectedCommentVersion` sẽ bị từ chối khi gỡ, client mới cần các trường count/version từ BE mới. MongoDB cần replica set theo cấu hình dự án để chạy transaction. Mongoose đăng ký collection/index khi khởi động; không cần migration Prisma hay biến env mới.

Kiểm thử HTTP với MongoDB thật:

```sh
npx vitest run --config vitest.config.e2e.mts test/e2e/comment-reports.e2e-spec.ts
```

Bao phủ phân quyền, validation, tự báo cáo, association sai, nội dung ẩn, receipt riêng tư, trim và snapshot, gửi trùng đồng thời, phân trang, bỏ qua, xóa phản hồi/cả luồng, bằng chứng sau khi xóa, race giữa các admin, rollback và race với xóa thường.

Các kiểm thử bổ sung cho gom nhóm kiểm tra tổng lượt xuyên trang/trạng thái, bằng chứng trước/sau chỉnh sửa, tương thích receipt cũ, phiên bản xem trước bị sửa/xóa, thiếu phiên bản và xác nhận lại bằng phiên bản mới. Kiểm thử trình duyệt bao phủ gom receipt nằm ở các trang API khác nhau, không gom nhầm nội dung giống nhau, bộ lọc trạng thái hỗn hợp và việc giữ nguyên phiên bản trong hộp xác nhận.

### Kết quả xác minh ngày 24/11/2026

- `npm run build` và `npm run lint`: pass, kể cả sau khi đồng bộ main `b36ec9b`.
- 16 kiểm thử HTTP mới và 93 kiểm thử hồi quy post interactions: pass với MongoDB replica set trong Docker.
- 34 unit test hiện có của interactions, admin reports và Mongo helpers: pass.
- Image production Docker build thành công. Smoke test gọi API trong container bằng tài khoản fixture, xác nhận 401/403, receipt 201, chống trùng 409, admin đọc hàng đợi, gỡ cả luồng trong transaction, đóng báo cáo liên quan và giữ bằng chứng.
- Provider credentials trong smoke test là placeholder cục bộ; luồng báo cáo không gọi AI hoặc gửi email.

### Kết quả xác minh gom nhóm ngày 28/11/2026

- BE build và lint: pass. Hai bộ kiểm thử HTTP `comment-reports` và `comment-notifications`: 40/40 pass với MongoDB thật.
- FE production build và lint phần thay đổi: pass; 16/16 kiểm thử Playwright, gồm giao diện desktop/mobile, gom nhóm xuyên trang và xác nhận lại sau chỉnh sửa.
- Image production Docker build và API smoke trong container: pass. Kiểm tra đếm toàn bộ lượt dù trang chỉ trả một receipt, giữ snapshot riêng của hai phiên bản, từ chối gỡ theo phiên bản cũ, gỡ bằng phiên bản mới, đóng cả hai báo cáo và gửi thông báo cho chủ bình luận.
- Sau khi restart container, bằng chứng, trạng thái đã xử lý và thông báo vẫn được lưu. Dữ liệu thử nghiệm dùng database/collection riêng và đã dọn; không dùng tài khoản production hoặc gọi nhà cung cấp AI.
