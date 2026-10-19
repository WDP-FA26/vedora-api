# Thông báo (Notifications)

Người dùng nhận thông báo khi có người khác **Sprout** (like), bình luận, đăng lại bài của mình hoặc theo dõi mình. Tự thao tác trên nội dung của chính mình không tạo thông báo. Like/repost/follow lặp lại (bật/tắt nhiều lần) chỉ tạo một thông báo.

Tất cả endpoint cần `Authorization: Bearer <accessToken>`.

## Realtime: `GET /notifications/sse`

Luồng `text/event-stream`. Mỗi sự kiện:

| `event` | `data` |
| --- | --- |
| `notification` | `NotificationDto` (JSON) |
| `ping` | `{}`, gửi mỗi 25 giây để giữ kết nối |

`EventSource` của trình duyệt **không gửi được header `Authorization`**, nên FE đọc luồng bằng `fetch()` + `response.body.getReader()` (hoặc thư viện như `@microsoft/fetch-event-source`) và tự kết nối lại khi bị ngắt hoặc sau khi refresh access token. Khi kết nối lại, gọi `GET /notifications/unread-count` để bù những thông báo đã bỏ lỡ.

Luồng chỉ phát tới các client đang kết nối vào **cùng một instance API**; chạy nhiều instance cần bus dùng chung.

## REST

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
  "readAt": null,
  "createdAt": "2026-10-19T08:00:00.000Z"
}
```

`postId` là `null` với `FOLLOW`; `commentId` chỉ có với `COMMENT`.
