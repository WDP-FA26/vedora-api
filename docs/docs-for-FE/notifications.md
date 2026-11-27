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

`POST_REMOVED` giữ `postId` của bài bị soft-delete để chủ bài mở `/posts/:id`,
xem lý do và tạo kháng cáo nếu còn đủ điều kiện. `REPORTED_POST_REMOVED` có
`postId = null`. Ở cả hai loại, `note` là đoạn trích bài/tên blog (tối đa 80
ký tự), **không** phải ghi chú admin hay thông tin người báo cáo.

Admin gỡ bài luôn lưu `POST_REMOVED` cho chủ bài còn tồn tại, kể cả bài chưa
có báo cáo, blog hoặc bài do chính admin đăng. `reason` ưu tiên lý do gỡ do
admin nhập; nếu bỏ trống dùng lý do báo cáo phổ biến nhất, không có thì null.
Tác giả tự xóa qua API cá nhân vẫn theo luồng riêng, không tạo thông báo bị
admin gỡ.

Trạng thái REMOVED, xử lý các báo cáo chờ và thông báo được ghi trong cùng
Mongo transaction. Nếu việc gỡ đóng một kháng cáo đang mở, thông báo kết quả
kháng cáo cũng được lưu trong transaction đó. Không lưu được thông báo thì
rollback, không có bài đã gỡ nhưng mất thông báo. SSE chỉ publish sau commit,
trước bước dọn search index. Khi offline, chủ bài vẫn xem lại bằng REST và
unread count. Yêu cầu gỡ lại bài đã REMOVED trả 409, không báo trùng. Nếu bài
đã được khôi phục rồi bị admin gỡ lần nữa thì có thông báo mới cho lần gỡ mới.

## Thông báo từ hệ thống (duyệt trang nhà hàng)

`actor` luôn là `null`.

| `type` | Người nhận | Khi nào | Trường đi kèm |
| --- | --- | --- | --- |
| `WORKSPACE_APPROVED` | Chủ trang (`OWNER`) | Admin duyệt đơn (`POST /admin/workspaces/:id/review` với `APPROVED`) | `workspaceId`, `note` (nếu admin có ghi chú) |
| `WORKSPACE_REJECTED` | Chủ trang (`OWNER`) | Admin từ chối đơn (`POST /admin/workspaces/:id/review` với `REJECTED`) | `workspaceId`, `reason` (`WorkspaceRejectReason`), `note` (nếu có; bắt buộc khi `reason` là `OTHER`) |

Ngoài thông báo trong ứng dụng, hệ thống cũng gửi email kết quả duyệt/từ chối đến email tài khoản chủ trang (đã xác minh) và `legal.contactEmail` (nếu khác email tài khoản).

## Người quản lý trang nhà hàng

`actor` là chủ trang (tài khoản cá nhân) đã thêm hoặc gỡ người quản lý. `note` là tên trang tại thời điểm đó.

| `type` | Người nhận | Khi nào | Trường đi kèm |
| --- | --- | --- | --- |
| `WORKSPACE_MANAGER_ADDED` | Người vừa được thêm | Chủ trang gọi `POST /workspaces/:id/members` | `workspaceId`, `note` (tên trang) |
| `WORKSPACE_MANAGER_REMOVED` | Người bị gỡ | Chủ trang gọi `DELETE /workspaces/:id/members/:userId`; người quản lý tự rời trang thì **không** có thông báo | `workspaceId`, `note` (tên trang) |

Sau `WORKSPACE_MANAGER_REMOVED`, người nhận không còn mở được `GET /workspaces/:id`, nên đừng dẫn link tới trang quản lý.
