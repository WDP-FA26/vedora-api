# Trung tâm Hỗ trợ (Support Tickets) & Kháng cáo kiểm duyệt

Hệ thống phiếu hỗ trợ hội thoại nhiều lượt dùng chung cho cả hỗ trợ người dùng và kháng cáo kiểm duyệt nội dung.

## 1. Danh mục (`SupportTicketCategory`)

- `CONTENT_APPEAL` (mã `APL-XXXXXX`): kháng cáo bài viết, video, blog bị `REJECTED` hoặc bị quản trị viên `REMOVED`.
  - Bắt buộc `postId`, trong vòng **14 ngày** kể từ thời điểm bị chặn/gỡ (`blockedAt`).
  - Khóa sửa/xóa bài viết (`409 APPEAL_IN_PROGRESS`) khi hồ sơ đang `OPEN` hoặc `WAITING_USER`.
  - Mỗi sự cố (`incidentKey`) chỉ có tối đa 1 hồ sơ đã giải quyết (`RESOLVED` / `CLOSED` / `EXPIRED`); cho phép rút (`WITHDRAWN`) tối đa 2 lần trong hạn 14 ngày.
  - Kết quả kháng cáo lưu ở `appeal.outcome`: `"APPROVED"` | `"REJECTED"` | `null`.
- `PAYMENT_ISSUE` (mã `TKT-XXXXXX`): hỗ trợ thanh toán / gói cước SePay (hỗ trợ tùy chọn `referenceCode`, ví dụ mã chuyển khoản).
- `VERIFICATION` (mã `TKT-XXXXXX`): hỏi đáp về xác minh chuyên gia.
- `GENERAL` (mã `TKT-XXXXXX`): báo lỗi, góp ý và các yêu cầu hỗ trợ khác.

## 2. Trạng thái (`SupportTicketStatus`)

- `OPEN`: chờ quản trị viên phản hồi.
- `WAITING_USER`: quản trị viên đã phản hồi, chờ người dùng bổ sung. Nếu người dùng im lặng, hệ thống nhắc theo kiểu "bump, bump, solve" của Zendesk (xem bên dưới) rồi mới đóng sang `EXPIRED`.
- `RESOLVED`: đã giải quyết (với `CONTENT_APPEAL`, xem `appeal.outcome` để biết chấp thuận hay bác bỏ).
- `CLOSED`: đã đóng (dành cho ticket không phải kháng cáo khi đóng/từ chối xử lý).
- `WITHDRAWN`: người dùng chủ động rút hồ sơ (mở khóa sửa bài nếu là `CONTENT_APPEAL`).
- `EXPIRED`: tự động đóng do quá hạn 7 ngày ở `WAITING_USER`.

**Nhắc và tự đóng (`WAITING_USER`):** tính từ `waitingUserSince` —
1. Sau **48 giờ** (`SUPPORT_FIRST_REMINDER_HOURS`): tin công khai `kind = "REMINDER"` + thông báo `SUPPORT_TICKET_REMINDER`.
2. Sau **120 giờ** (`SUPPORT_FINAL_REMINDER_HOURS`): lời nhắc cuối, ghi rõ giờ đóng.
3. Sau **168 giờ** (`APPEAL_WAITING_USER_EXPIRE_DAYS` × 24) **và** ít nhất 48 giờ sau lời nhắc cuối: đóng sang `EXPIRED` (+ `SUPPORT_TICKET_EXPIRED`).

Hồ sơ chưa nhận đủ 2 lời nhắc thì không bao giờ bị đóng. Mọi tin trả lời (người dùng hoặc quản trị viên) đặt lại bộ đếm. `autoCloseAt` (trên list item và detail) là thời điểm dự kiến đóng, `null` nếu hồ sơ không ở `WAITING_USER`. Tin `REMINDER` có `senderRole = "ADMIN"`, `sender = null` và không đổi `lastMessageAt`.

Mỗi bước (2 lời nhắc và lúc đóng) cũng được gửi email qua Resend tới người tạo hồ sơ, nếu email đã xác minh và tài khoản đang `ACTIVE`. Email có mã hồ sơ, tiêu đề, nội dung lời nhắc và nút mở `FRONTEND_URL/home/support/{id}`. Gửi email thất bại không chặn lời nhắc trong app. Khi không có `RESEND_API_KEY`, email chỉ được in ra log API.

**Mở lại:** với ticket **không phải** `CONTENT_APPEAL` đã kết thúc (`RESOLVED` / `CLOSED` / `WITHDRAWN` / `EXPIRED`), người dùng gửi tin mới trong vòng **30 ngày** kể từ `resolvedAt` (`SUPPORT_REOPEN_WINDOW_DAYS`) sẽ tự mở lại hồ sơ: trạng thái về `OPEN`, xóa `resolvedAt` / `resolutionNote`, giữ nguyên người phụ trách, và chèn một tin hệ thống `kind = "REOPENED"` trước tin của người dùng. `SupportTicketDetailDto.reopenableUntil` cho biết hạn chót (`null` nếu không mở lại được hoặc đã quá hạn). Quá hạn → `409 TICKET_REOPEN_WINDOW_EXPIRED`; kháng cáo → `409 TICKET_ALREADY_CLOSED`; mở lại vẫn tính vào giới hạn 5 hồ sơ đang hoạt động (`409 TICKET_LIMIT_REACHED`).

**Người phụ trách (claim):** `assigneeId` là quản trị viên đang xử lý. Chỉ người phụ trách được phản hồi công khai và kết luận hồ sơ; quản trị viên khác nhận `409 TICKET_CLAIMED_BY_OTHER` cho tới khi tiếp quản (`force: true`). Phản hồi hoặc kết luận một hồ sơ chưa ai nhận sẽ tự gán cho người thao tác. Ghi chú nội bộ thì mọi quản trị viên đều thêm được, kể cả khi hồ sơ đã đóng.

**Ảnh đính kèm:** tối đa 4 ảnh JPEG/PNG/WebP (≤ 10 MB mỗi ảnh) mỗi tin. Luồng: `POST /support/attachments` → `PUT` file lên `upload.url` với đúng `upload.headers` → gửi `attachmentIds` khi tạo ticket hoặc gửi tin. Mỗi ảnh chỉ dùng được một lần và chỉ bởi chính người tải lên (`400 UNKNOWN_ATTACHMENT`); file chưa tải xong → `409 ATTACHMENT_NOT_UPLOADED`. Tin có thể chỉ có ảnh (khi đó `body = ""`); thiếu cả hai → `400 TICKET_MESSAGE_EMPTY`. Ảnh lưu ở bucket riêng tư `STORAGE_SUPPORT_BUCKET`; `SupportMessageDto.attachments[].url` là link ký hạn 1 giờ, nên tải lại hồ sơ nếu ảnh hết hạn. Ảnh chưa gửi bị dọn sau 2 ngày.

Giới hạn chống lạm dụng: tối đa 5 hồ sơ đang hoạt động mỗi tài khoản, văn bản thuần `1..2000` ký tự, tối đa 50 tin công khai/hồ sơ, người dùng gửi tối đa 3 tin liên tiếp khi admin chưa phản hồi (`409 TICKET_WAIT_FOR_ADMIN`).

## 3. Endpoints

### Phía người dùng (`/api/v1/support/tickets`)
- `POST /support/attachments` `{ contentType, sizeBytes }` → `201 { id, upload: { url, method: "PUT", headers, expiresAt } }` (dùng chung cho người dùng và quản trị viên)
- `POST /support/tickets` `{ category, subject?, message, postId?, reasonCategory?, referenceCode?, attachmentIds? }` → `201 SupportTicketDetailDto`
- `GET /support/tickets?status=&category=&page=&limit=` → `PaginatedResponseDto<SupportTicketListItemDto>`
- `GET /support/tickets/:id` → `SupportTicketDetailDto` (chỉ tin công khai `isInternal = false`)
- `POST /support/tickets/:id/messages` `{ body?, attachmentIds? }` → `200 SupportTicketDetailDto` (`WAITING_USER → OPEN`; hồ sơ đã kết thúc thì mở lại, xem mục 2)
- `POST /support/tickets/:id/withdraw` → `200 SupportTicketDetailDto` (`WITHDRAWN`)

### Phía quản trị (`/api/v1/admin/support/tickets`)
- `GET /admin/support/tickets?status=&category=&triggerStatus=&assignee=me|unassigned&q=&page=&limit=` → `AdminSupportTicketsPageDto` (kèm `counts` theo trạng thái và `categoryCounts` theo danh mục; hàng chờ `OPEN`/`WAITING_USER` sắp xếp FIFO)
- `GET /admin/support/tickets/:id` → `AdminSupportTicketDetailDto` (gồm cả `isInternal: true` và đầy đủ `post: AdminPostDto` khi là `CONTENT_APPEAL`)
- `POST /admin/support/tickets/:id/messages` `{ body?, attachmentIds?, isInternal?: false }` → `200 AdminSupportTicketDetailDto` (công khai: cần hồ sơ đang hoạt động và do mình phụ trách hoặc chưa ai nhận; nội bộ: mọi trạng thái)
- `POST /admin/support/tickets/:id/claim` `{ force?: boolean }` → `200 AdminSupportTicketDetailDto` (nhận xử lý; `force` để tiếp quản từ quản trị viên khác)
- `POST /admin/support/tickets/:id/release` → `200 AdminSupportTicketDetailDto` (trả hồ sơ mình đang giữ về hàng chờ chung)
- `AdminSupportTicketListItemDto` có thêm `assignee: PostAuthorDto | null` và `assignedAt`.
- `POST /admin/support/tickets/:id/resolve` `{ decision, note? }` → `200 AdminSupportTicketDetailDto`
  - Với `CONTENT_APPEAL`: `decision` là `"APPROVE"` hoặc `"REJECT"` (`REJECT` bắt buộc `note` ≥ 5 ký tự).
  - Với danh mục khác: `decision` là `"RESOLVE"` hoặc `"CLOSE"` (`CLOSE` bắt buộc `note` ≥ 5 ký tự).

## 4. Soft-delete & Khôi phục bài viết (`PostStatus.REMOVED`)
- Tác giả xóa (`DELETE /posts/:id`, `DELETE /blogs/:id`): soft-delete (`removal.removedByRole = "AUTHOR"`), ẩn hoàn toàn, không kháng cáo được, admin có thể khôi phục.
- Admin gỡ (`DELETE /admin/posts/:id`, body tùy chọn `{ reason? }`): soft-delete (`removal.removedByRole = "ADMIN"`), tự đóng report `PENDING`, giữ `postId` trong `POST_REMOVED` để tác giả mở kháng cáo trong 14 ngày.
- Admin khôi phục (`POST /admin/posts/:id/restore`, body tùy chọn `{ note? }`): trả bài về `previousStatus`, tự đóng hồ sơ kháng cáo đang mở với `outcome = "APPROVED"` và gửi `SUPPORT_TICKET_RESOLVED` (hoặc `POST_RESTORED` nếu không có hồ sơ mở).

## 5. Thông báo (`NotificationType`)
`NotificationDto` có thêm trường `ticketId: string | null`:
- `POST_RESTORED`: bài bị gỡ đã được khôi phục trực tiếp.
- `SUPPORT_TICKET_REPLIED`: quản trị viên phản hồi trong hồ sơ hỗ trợ.
- `SUPPORT_TICKET_RESOLVED`: hồ sơ đã giải quyết (`reason` là `"APPEAL_APPROVED"` hoặc `"APPEAL_REJECTED"` nếu là kháng cáo nội dung).
- `SUPPORT_TICKET_CLOSED`: hồ sơ hỗ trợ đã đóng.
- `SUPPORT_TICKET_REMINDER`: nhắc người dùng trả lời hồ sơ đang chờ họ (`note` là nội dung lời nhắc).
- `SUPPORT_TICKET_EXPIRED`: hồ sơ tự động đóng sau 2 lần nhắc mà người dùng vẫn không phản hồi.
