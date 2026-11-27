# Thông báo (Notifications)

Người dùng nhận thông báo khi có người khác **thích** (like), bình luận, đăng lại bài của mình hoặc theo dõi mình. Tự thao tác trên nội dung của chính mình không tạo thông báo. Like/repost/follow lặp lại (bật/tắt nhiều lần) chỉ tạo một thông báo.

Tất cả endpoint cần `Authorization: Bearer <accessToken>`.

## Realtime: `GET /notifications/sse`

Luồng `text/event-stream`. Mỗi sự kiện:

| `event` | `data` |
| --- | --- |
| `notification` | `NotificationDto` (JSON) |
| `ping` | `{}`, gửi mỗi 25 giây để giữ kết nối |

`EventSource` của trình duyệt **không gửi được header `Authorization`**, nên FE đọc luồng bằng `fetch()` + `response.body.getReader()` (hoặc thư viện như `@microsoft/fetch-event-source`) và tự kết nối lại khi bị ngắt hoặc sau khi refresh access token. Khi kết nối lại, gọi `GET /notifications/unread-count` để bù những thông báo đã bỏ lỡ.

Luồng chỉ phát tới các client đang kết nối vào **cùng một instance API**; chạy nhiều instance cần bus dùng chung.

## Thông báo cấp gói

Khi admin cấp Plus/Pro, người được cấp nhận `type: "SUBSCRIPTION_GRANTED"`:
`actor`, `postId`, `commentId`, `ticketId`, `workspaceId`, `reason` đều null;
`note` là nội dung hệ thống gồm tên gói, số ngày và thời điểm hết hạn theo
`APP_TIMEZONE` (mặc định UTC+7). Không phải lý do cấp nội bộ do admin nhập.
`readAt` ban đầu null. Dùng hình dạng NotificationDto thông thường, không có
field bắt buộc mới.

FE hiển thị nguồn Vedora, icon quà tặng, dùng note làm thông điệp, link `/billing`.
Notification nằm trong danh sách/unread count; online nhận SSE để hiện toast
và tăng badge. Nhận event này thì revalidate billing/me; stream cũng được mở
trên trang billing/payment. Nếu note thiếu, dùng thông điệp cấp gói chung.

Thông báo lưu cùng transaction grant/membership, chỉ phát sau commit. Lỗi lưu
notification rollback cả lần cấp. Retry không cấp lại hay báo trùng. Offline
vẫn đọc lại bằng REST; không tạo bù cho các grant trước tính năng này. Không
gửi email cho lần cấp gói. SSE vẫn có giới hạn cùng instance như mô tả ở trên.

## REST endpoints

| Method | Path | Mô tả |
| --- | --- | --- |
| GET | `/notifications?limit=&cursor=` | Danh sách mới nhất trước, phân trang cursor (xem `pagination.md`) |
| GET | `/notifications/unread-count` | `{ "unreadCount": 3 }` |
| POST | `/notifications/read` | Đánh dấu tất cả đã đọc (204) |
| POST | `/notifications/:id/read` | Đánh dấu một thông báo đã đọc (204) |

## `NotificationDto`

```json
{
  "id": "uuid",
  "type": "LIKE | COMMENT | REPOST | FOLLOW",
  "actor": { "id": "uuid", "username": "…", "fullName": "…", "avatarUrl": null },
  "postId": "uuid | null",
  "commentId": "uuid | null",
  "ticketId": "uuid | null",
  "workspaceId": "uuid | null",
  "readAt": null,
  "createdAt": "2026-10-19T08:00:00.000Z"
}
```

`postId` là `null` với `FOLLOW`; `commentId` chỉ có với `COMMENT`.


## Thông báo từ hệ thống (kiểm duyệt)

`type` có thêm `POST_PUBLISHED`, `POST_PENDING_REVIEW`, `POST_APPROVED`, `POST_REJECTED`. Với chúng `actor` là `null`, và có thêm `postType`, `reason`, `note`. Xem `content-moderation.md`.

## Thông báo từ hệ thống (báo cáo bài viết)

`actor` luôn là `null`.

| `type` | Người nhận | Khi nào | Trường đi kèm |
| --- | --- | --- | --- |
| `REPORT_RESOLVED` | Người báo cáo | Admin bấm "Đã xử lý" (`POST /admin/reports/:id/review` với `RESOLVED`) | `postId`, `postType`, `reason` = lý do báo cáo (`SPAM`, …) |
| `REPORT_DISMISSED` | Người báo cáo | Admin bấm "Bỏ qua" (`DISMISSED`) | như trên |
| `POST_REMOVED` | Chủ bài | Admin xoá bài (`DELETE /admin/posts/:id`) | `reason` = lý do bị báo cáo nhiều nhất, `null` nếu bài không có báo cáo; `note` = tiêu đề blog hoặc đầu bài |
| `REPORTED_POST_REMOVED` | Mọi người đã báo cáo bài đó | Admin xoá bài | `note` = tiêu đề blog hoặc đầu bài |

Bài đã bị xoá nên `POST_REMOVED` và `REPORTED_POST_REMOVED` có `postId` = `null`. Ở hai loại này `note` là đoạn trích bài, **không** phải ghi chú của admin. Admin tự xoá bài của chính mình thì không có `POST_REMOVED`.

## Thông báo từ hệ thống (duyệt trang nhà hàng)

`actor` luôn là `null`.

| `type` | Người nhận | Khi nào | Trường đi kèm |
| --- | --- | --- | --- |
| `WORKSPACE_APPROVED` | Chủ trang (`OWNER`) | Admin duyệt đơn (`POST /admin/workspaces/:id/review` với `APPROVED`) | `workspaceId`, `note` (nếu admin có ghi chú) |
| `WORKSPACE_REJECTED` | Chủ trang (`OWNER`) | Admin từ chối đơn (`POST /admin/workspaces/:id/review` với `REJECTED`) | `workspaceId`, `reason` (`WorkspaceRejectReason`), `note` (nếu có; bắt buộc khi `reason` là `OTHER`) |

Ngoài thông báo trong ứng dụng, hệ thống cũng gửi email kết quả duyệt/từ chối đến email tài khoản chủ trang (đã xác minh) và `legal.contactEmail` (nếu khác email tài khoản).
