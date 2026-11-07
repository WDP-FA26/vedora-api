# Nhắn tin riêng realtime

Đã triển khai backend và frontend tại `/home/messages`. Đây là chat văn bản 1:1, tối đa 2.000 ký tự sau khi trim. Các ID đều là UUID v4. Chưa có nhóm, file đính kèm, sửa/xóa tin hoặc trạng thái đang nhập.

## Quy tắc theo dõi

| Quan hệ giữa A và B | A gửi cho B | B gửi cho A | Hộp thư |
| --- | --- | --- | --- |
| Không ai theo dõi ai | Không | Không | Chưa có cuộc trò chuyện mới |
| A theo dõi B | Có | Phải theo dõi A trước | `requests` ở cả hai phía |
| A và B theo dõi nhau | Có | Có | `friends` ở cả hai phía |
| Một phía bỏ theo dõi sau khi đã chat | Chỉ phía còn theo dõi được gửi | Áp dụng cùng quy tắc | Chuyển về `requests`, giữ lịch sử |

Không có bước chấp nhận lời nhắn riêng. Người nhận theo dõi lại là đủ để trở thành bạn bè và trả lời. Hộp thư lạ chứa cả lời nhắn đến và lời nhắn đã gửi. Khi cả hai bỏ theo dõi, cuộc trò chuyện cũ vẫn nằm ở `requests`, cả hai không được gửi tiếp.

`canSend`, `followsPeer`, `peerFollowsYou` và `box` được tính theo quan hệ hiện tại. FE dùng `canSend` để hiển thị composer; BE kiểm tra lại mỗi lần gửi. Tài khoản người nhận bị đình chỉ không nhận tin mới; lịch sử cũ vẫn được giữ. Xóa hẳn một tài khoản sẽ xóa các cuộc trò chuyện, tin nhắn và sự kiện liên quan.

Tất cả endpoint yêu cầu `Authorization: Bearer <accessToken>` và tài khoản đang hoạt động. Chỉ hai người tham gia được đọc/gửi/đánh dấu đã đọc. Admin không có quyền đọc cuộc trò chuyện của người khác; trường hợp này trả `404 NOT_FOUND`.

## Endpoint

Các đường dẫn bên dưới có prefix `/api/v1`.

| Method | Endpoint | Mục đích |
| --- | --- | --- |
| GET | `/messaging/users/:userId` | Lấy người nhận, quyền gửi và `conversationId` hiện có; không tạo cuộc trò chuyện rỗng |
| GET | `/messaging/conversations?box=friends&limit=20&cursor=…` | Hộp thư bạn bè; `box=requests` cho tin nhắn lạ |
| GET | `/messaging/conversations/:id` | Chi tiết cuộc trò chuyện, quan hệ và trạng thái đọc hiện tại |
| GET | `/messaging/conversations/:id/messages?limit=30&cursor=…` | Lịch sử tin nhắn, mới nhất trước |
| POST | `/messaging/users/:userId/messages` | Gửi tin đầu tiên hoặc gửi vào cuộc trò chuyện đã có của cặp user |
| POST | `/messaging/conversations/:id/messages` | Gửi vào cuộc trò chuyện hiện có |
| PUT | `/messaging/conversations/:id/read` | Tăng vị trí đã đọc của chính người gọi |
| GET | `/messaging/events` | SSE riêng tư cho user đang đăng nhập |

Các GET JSON và SSE dùng `Cache-Control: private, no-store`.

### Mở chat từ hồ sơ

Gọi `GET /messaging/users/:userId`:

```json
{
  "peer": {
    "id": "d63f9256-9baa-4fbb-ad04-07966ae7ff89",
    "username": "bob",
    "fullName": "Bob",
    "avatarUrl": null,
    "isProfessional": false
  },
  "conversationId": null,
  "box": "requests",
  "followsPeer": false,
  "peerFollowsYou": false,
  "canSend": false
}
```

Nếu `conversationId` có giá trị, tải lịch sử hiện có. Nếu `canSend=false` và chưa theo dõi, hiển thị nút theo dõi (`PUT /profiles/:userId/follow`). Không tạo chat chỉ vì người dùng mở trang hồ sơ.

### Gửi và retry

Body của cả hai POST:

```json
{
  "clientMessageId": "6d1184dc-e2d8-4143-993c-7a0199025135",
  "body": "Chào bạn!"
}
```

Response `201`:

```json
{
  "conversationId": "eb96ee73-c9ba-486c-b9ca-33d06d135489",
  "message": {
    "id": "d06868ca-59cb-483f-ac14-59db9cfc4f4f",
    "conversationId": "eb96ee73-c9ba-486c-b9ca-33d06d135489",
    "senderId": "a073eeb9-94a1-4eb7-853c-682623868d98",
    "recipientId": "d63f9256-9baa-4fbb-ad04-07966ae7ff89",
    "clientMessageId": "6d1184dc-e2d8-4143-993c-7a0199025135",
    "sequence": 1,
    "body": "Chào bạn!",
    "createdAt": "2026-11-07T05:00:00.000Z"
  }
}
```

FE tạo `crypto.randomUUID()` cho mỗi tin mới. Khi request mất mạng hoặc mất phản hồi sau khi server đã ghi, giữ lại nội dung và **dùng lại UUID đó với cùng nội dung**. BE trả lại cùng tin nhắn, không tăng sequence, không tạo thêm unread/event. Dùng lại UUID với nội dung khác trả `409 MESSAGE_ID_CONFLICT`. Chỉnh nội dung là một lần gửi mới với UUID mới. Quyền theo dõi vẫn được kiểm tra lại khi retry.

Không tự hiển thị tin như đã gửi trước khi có xác nhận từ API. Gộp response POST và GET theo `message.id` để tránh trùng. Server bảo đảm một cuộc trò chuyện cho một cặp người dùng, kể cả khi hai bên gửi đồng thời.

### Danh sách và phân trang

Cả inbox và lịch sử dùng `{ "items": [], "nextCursor": null }`. `limit` mặc định 20, từ 1 đến 50. Bỏ `cursor` ở trang đầu, dùng nguyên `nextCursor` ở trang sau. `null` nghĩa là hết trang.

Inbox được lọc theo `box` trước khi phân trang và sắp theo hoạt động gần nhất giảm dần, có ID làm khóa phụ. Mỗi item:

```ts
type Conversation = {
  id: string
  peer: { id: string; username: string; fullName: string; avatarUrl: string | null; isProfessional: boolean }
  box: 'friends' | 'requests'
  requestDirection: 'incoming' | 'outgoing' | null
  followsPeer: boolean
  peerFollowsYou: boolean
  canSend: boolean
  lastMessage: { id: string; senderId: string; body: string; createdAt: string } | null
  unreadCount: number
  myReadSequence: number
  peerReadSequence: number
}
```

`requestDirection` là `incoming` khi chỉ người kia theo dõi mình, `outgoing` khi chỉ mình theo dõi họ, `null` khi đã là bạn bè hoặc cả hai đã bỏ theo dõi. Sau sự kiện gửi tin hoặc thay đổi theo dõi, FE tải lại inbox từ trang đầu để tránh dùng cursor của thứ tự/hộp thư cũ. Cursor inbox chuyển sang hộp thư khác trả `400 MESSAGE_CURSOR_INVALID`; cursor không thuộc người gọi trả `404`.

Lịch sử sắp `sequence DESC`, không phụ thuộc thời gian máy client. FE gộp các trang, loại trùng theo ID rồi hiển thị `sequence ASC`. Cursor là ID của tin cuối trang; cursor của cuộc trò chuyện khác hoặc không còn tồn tại trả `400 MESSAGE_CURSOR_INVALID`.

### Đã đọc

`PUT /messaging/conversations/:id/read` nhận `{ "messageId": "<UUID v4 của tin đã hiển thị>" }`, trả:

```json
{ "conversationId": "eb96ee73-c9ba-486c-b9ca-33d06d135489", "readSequence": 1, "unreadCount": 0 }
```

Vị trí đọc chỉ tăng, không lùi. BE yêu cầu tin thực sự thuộc cuộc trò chuyện; không nhận sequence tùy ý. `unreadCount` chỉ tính tin đến sau vị trí đọc của chính mình. GET không tự đánh dấu đã đọc. FE hiện chỉ đánh dấu khi cuộc trò chuyện đang hiển thị, tab có focus và người dùng ở cuối lịch sử. Tin mình gửi có `sequence <= peerReadSequence` hiển thị “Đã xem”.

## Realtime bằng SSE

Client gửi tin qua POST và nhận thay đổi qua SSE. Dùng `fetchEventSource` với header Bearer; không đặt token trong URL. Một kết nối dùng chung cho layout `/home`, kể cả khi người dùng đang xem trang khác.

| Event | Payload | Cách xử lý |
| --- | --- | --- |
| `stream.ready` | `{}` | Đã kết nối change stream; đồng bộ lại inbox, chi tiết và lịch sử |
| `stream.unavailable` | `{}` | Bật polling GET trong lúc chờ khôi phục |
| `message.created` | Metadata bên dưới | Tải lại inbox, chi tiết và lịch sử chat liên quan |
| `conversation.read` | Metadata bên dưới | Tải lại unread và vị trí đã đọc |
| `relationship.changed` | Metadata bên dưới, các field có thể null | Tải lại quyền gửi, inbox từ trang đầu và thông tin contact |
| `ping` | `{ "connected": true }` hoặc `false` | Heartbeat mỗi 15 giây; phản ánh tình trạng change stream |
| `session.expired` | `{}` | Ngắt stream, refresh phiên hoặc đăng nhập lại |

Metadata của event nghiệp vụ:

```json
{
  "conversationId": "eb96ee73-c9ba-486c-b9ca-33d06d135489",
  "messageId": "d06868ca-59cb-483f-ac14-59db9cfc4f4f",
  "readerId": null,
  "readSequence": null
}
```

`messageId` chỉ có ở `message.created`; `readerId/readSequence` có ở `conversation.read`. Thay đổi quan hệ có thể không có `conversationId`. Sự kiện chỉ gửi đến hai user liên quan, không mang nội dung tin nhắn hoặc danh sách người nhận nội bộ.

SSE là tín hiệu tải lại dữ liệu, **GET là nguồn dữ liệu chính**. Không dựa vào `Last-Event-ID` để replay và không giả định mỗi event chỉ xuất hiện đúng một lần. Khi reconnect phải tải lại dữ liệu để bù các event đã bỏ lỡ. FE fallback polling mỗi 5 giây khi stream chưa sẵn sàng, retry kết nối khi lỗi mạng; khi quá 35 giây không nhận frame thì mở lại stream. JWT và trạng thái tài khoản được kiểm tra lại trên mỗi event và mỗi heartbeat; stream hết quyền sẽ đóng.

## Lưu trữ và triển khai

Không cần thêm biến môi trường hoặc dependency. Dùng MongoDB replica set hiện có; standalone MongoDB không hỗ trợ transaction/change streams cần cho tính năng này.

- `conversations`: một cặp thành viên duy nhất, sequence và vị trí đọc riêng của mỗi phía, preview cuối.
- `direct_messages`: unique `(conversationId, sequence)` và `(conversationId, senderId, clientMessageId)`.
- `messaging_events`: outbox được ghi trong cùng transaction với gửi/đọc/theo dõi. MongoDB change stream phát các event đã commit cho các instance API. TTL 7 ngày chỉ áp dụng cho outbox, không xóa tin nhắn.
- Thay đổi theo dõi, gửi và đọc dùng cùng thứ tự khóa user với quản trị tài khoản để tránh race khi gửi/unfollow/xóa account đồng thời.

Mongoose đăng ký collection/index khi khởi động; không có Prisma migration. Reverse proxy cần cho phép SSE chạy lâu và không buffer response (`X-Accel-Buffering: no` đã được đặt ở API).

## Frontend đã tích hợp

- Trang `/home/messages`: inbox bạn bè/tin nhắn lạ, unread, lịch sử phân trang, composer và read receipt; bố cục desktop hai cột và mobile quay lại hộp thư.
- `/home/messages?to=<userId>` mở từ nút “Nhắn tin” trên hồ sơ; `?conversation=<id>` mở chat có sẵn.
- `features/messaging/schemas.ts`, `lib/messaging-api.ts`: contract Zod và API client.
- `hooks/use-messaging.ts`, `hooks/use-messaging-stream.ts`: cache theo access token, GET/SSE, reconcile khi reconnect.
- `components/messages-view.tsx`: UI; `components/messaging-stream.tsx` gắn tại home layout.
- Hook follow hiện có làm mới quyền chat và inbox ngay sau thay đổi quan hệ.

## Mã lỗi và kiểm thử

| HTTP | Code | FE xử lý |
| --- | --- | --- |
| 400 | `VALIDATION_FAILED` | Tin rỗng/quá dài, UUID hoặc limit sai |
| 400 | `SELF_MESSAGE_NOT_ALLOWED` | Không nhắn cho chính mình |
| 400 | `MESSAGE_CURSOR_INVALID` | Bỏ cursor, tải lại trang đầu |
| 401 | `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_NOT_ACTIVE` | Refresh phiên/đăng nhập lại |
| 403 | `MESSAGE_FOLLOW_REQUIRED` | Yêu cầu theo dõi trước khi gửi |
| 404 | `NOT_FOUND` | Người nhận không khả dụng hoặc chat/tin không thuộc người gọi |
| 409 | `MESSAGE_ID_CONFLICT` | UUID đã dùng cho nội dung khác; không retry mù |
| 409 | `CONFLICT` | Xung đột ghi đồng thời còn tồn tại sau retry; giữ nội dung để thử lại |

Chạy `npm run test:e2e -- test/messaging.e2e-spec.ts` với MongoDB local replica set. Suite dùng database ngẫu nhiên, tạo index và tự xóa database sau test. Bao phủ phân loại inbox, quyền admin/user, giới hạn nội dung, cursor, đồng thời, idempotency, unread, follow/unfollow, xóa tài khoản, stream riêng tư, nhiều instance và JWT hết hạn/đình chỉ. Test không ghi vào database ứng dụng.
