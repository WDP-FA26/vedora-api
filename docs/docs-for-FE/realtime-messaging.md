# Nhắn tin riêng realtime

Đã triển khai backend và frontend tại `/home/messages`. Chat 1:1 hỗ trợ văn bản tối đa 2.000 ký tự sau khi trim và chia sẻ post/blog qua thẻ bài viết. Các ID đều là UUID v4. Chưa có nhóm, file đính kèm, sửa/xóa tin hoặc trạng thái đang nhập.

## Quy tắc theo dõi và chấp nhận lời mời

| Quan hệ giữa A và B                       | A gửi cho B                    | B gửi cho A                                        | Hộp thư                                      |
| ----------------------------------------- | ------------------------------ | -------------------------------------------------- | -------------------------------------------- |
| Không ai theo dõi ai                      | Không                          | Không                                              | Chưa có cuộc trò chuyện mới                  |
| A theo dõi B, lời mời chưa được chấp nhận | Có                             | Chấp nhận lời mời để trả lời, không cần follow lại | `requests` ở cả hai phía                     |
| A và B theo dõi nhau                      | Có                             | Có                                                 | `friends` ở cả hai phía                      |
| B đã chấp nhận lời mời của A              | Có, kể cả khi unfollow         | Có, không cần follow A                             | `friends` ở cả hai phía                      |
| Bỏ theo dõi khi chưa từng chấp nhận       | Chỉ phía còn theo dõi được gửi | Có thể chấp nhận lời mời đến để trả lời            | Về `requests` nếu không còn follow hai chiều |

Người nhận có hai thao tác **Xóa** và **Chấp nhận**. Chấp nhận lưu quyền trò chuyện độc lập với Follow, chuyển sang `friends` ở cả hai phía và không tạo quan hệ theo dõi. Hộp thư lạ vẫn chứa cả lời nhắn đến và lời nhắn đã gửi. Người mở đầu không thể tự chấp nhận lời mời của mình. Hướng lời mời dựa vào người gửi tin đầu tiên, không bị đảo hoặc mất khi unfollow. Các conversation cũ chưa có thông tin người mở đầu được suy ra từ tin đầu tiên, không cần migration/backfill trước khi chạy.

`canSend` và `box` xét cả trạng thái chấp nhận và Follow; `followsPeer`/`peerFollowsYou` vẫn phản ánh Follow thật. FE dùng `canAcceptRequest`/`canDeleteRequest` do BE trả để hiện hai nút. BE kiểm tra quyền, thành viên và trạng thái tài khoản trong transaction. Tài khoản bị đình chỉ không thể gửi/nhận tin mới dù conversation đã được chấp nhận. Xóa hẳn tài khoản vẫn dọn conversation/message/outbox theo cơ chế có sẵn.

Tất cả endpoint yêu cầu `Authorization: Bearer <accessToken>` và tài khoản đang hoạt động. Chỉ hai người tham gia được đọc/gửi/đánh dấu đã đọc. Admin không có quyền đọc cuộc trò chuyện của người khác; trường hợp này trả `404 NOT_FOUND`.

## Endpoint

Các đường dẫn bên dưới có prefix `/api/v1`.

| Method | Endpoint                                                  | Mục đích                                                                              |
| ------ | --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| GET    | `/messaging/users/:userId`                                | Lấy người nhận, quyền gửi và `conversationId` hiện có; không tạo cuộc trò chuyện rỗng |
| GET    | `/messaging/conversations?box=friends&limit=20&cursor=…`  | Hộp thư bạn bè; `box=requests` cho tin nhắn lạ                                        |
| GET    | `/messaging/conversations/:id`                            | Chi tiết cuộc trò chuyện, quan hệ và trạng thái đọc hiện tại                          |
| GET    | `/messaging/conversations/:id/messages?limit=30&cursor=…` | Lịch sử tin nhắn, mới nhất trước                                                      |
| POST   | `/messaging/users/:userId/messages`                       | Gửi tin đầu tiên hoặc gửi vào cuộc trò chuyện đã có của cặp user                      |
| POST   | `/messaging/conversations/:id/messages`                   | Gửi vào cuộc trò chuyện hiện có                                                       |
| POST   | `/messaging/users/:userId/shared-posts`                   | Chia sẻ bài vào cuộc trò chuyện của cặp user, tạo nếu chưa có                         |
| POST   | `/messaging/conversations/:id/shared-posts`               | Chia sẻ bài vào cuộc trò chuyện hiện có                                               |
| PUT    | `/messaging/conversations/:id/read`                       | Tăng vị trí đã đọc của chính người gọi                                                |
| POST   | `/messaging/conversations/:id/accept`                     | Người nhận chấp nhận lời mời, trả Conversation `200`                                  |
| DELETE | `/messaging/conversations/:id/request`                    | Ẩn lời mời/lịch sử cũ ở phía người nhận, trả `200`                                    |
| GET    | `/messaging/events`                                       | SSE riêng tư cho user đang đăng nhập                                                  |

Các GET JSON và SSE dùng `Cache-Control: private, no-store`.

### Chia sẻ bài viết qua tin nhắn

Hai POST `shared-posts` nhận đúng hai trường:

```json
{
  "clientMessageId": "6d1184dc-e2d8-4143-993c-7a0199025135",
  "postId": "11111111-1111-4111-8111-111111111111"
}
```

- Chỉ chia sẻ post/blog `PUBLISHED`. Bài bị xóa/ẩn/chưa xuất bản trả
  `404 SHARED_POST_UNAVAILABLE`, kể cả bài của chính người gửi.
- Cùng quyền nhắn tin hiện có: theo dõi người nhận hoặc conversation đã được chấp
  nhận. Kiểm tra trạng thái tài khoản, thành viên, và quyền gửi lại trong transaction.
  Người ngoài không đọc/gửi vào conversation của người khác, kể cả admin.
- Không nhận body, title, author hay preview từ client; metadata giả bị từ chối 400.
- Trả `201 { conversationId, message }` như gửi văn bản. `message` có thêm
  `sharedPostId: string | null` và `sharedPost: SharedPost | null`:

```ts
interface SharedPost {
  id: string;
  type: 'POST' | 'BLOG';
  title: string | null;
  excerpt: string;
  imageUrl: string | null;
  author: {
    id: string;
    username: string;
    fullName: string;
    avatarUrl: string | null;
  };
}
```

- `excerpt` giới hạn theo `BLOG_EXCERPT_MAX_LENGTH` hiện có. Blog có title/cover;
  post có phần đầu nội dung. Hiển thị như text, không render HTML/Markdown.
- Database chỉ lưu `sharedPostId` và câu mô tả chung trong `body`, không lưu snapshot
  nội dung. GET lịch sử và response retry hydrate từ bài công khai hiện tại theo batch.
  Bài bị gỡ/ẩn hoặc thiếu tác giả trả `sharedPost=null`, vẫn giữ tin nhắn và ID tham
  chiếu. FE hiện “Bài viết không còn khả dụng” khi tải lại lịch sử, không mở link.
- Tin văn bản cũ có hai field null. Không cần migration/backfill. Không cascade xóa
  tin nhắn khi xóa bài; cascade khi xóa người tham gia vẫn giữ hành vi hiện có.
- Dùng cùng không gian idempotency `(conversation, sender, clientMessageId)` với
  tin văn bản. Retry đúng bài giữ nguyên message/sequence, không thêm unread/outbox;
  đổi bài hoặc đổi loại nội dung với cùng ID trả `409 MESSAGE_ID_CONFLICT`.
  Retry tin đã gửi vẫn thành công khi bài sau đó bị gỡ (preview null), nhưng vẫn
  phải có quyền nhắn tin và tài khoản hoạt động.
- Share làm tăng unread, hỗ trợ read receipt và phát `message.created` qua outbox
  như tin văn bản. SSE chỉ chứa ID để invalidate cache, không chứa nội dung bài.
- FE nút Chia sẻ mở hai lựa chọn: gửi tin nhắn hoặc sao chép liên kết. Người nhận
  gồm các cuộc trò chuyện (cả lời mời) và người đang theo dõi, có phân trang/lọc tên.
  Người chưa có quyền gửi bị vô hiệu hóa; BE là nơi kiểm tra cuối cùng.

Triển khai BE trước FE. Không thêm biến môi trường hay gọi provider AI cho tính năng này.

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

Nếu `conversationId` có giá trị, tải conversation/lịch sử để lấy quyền xử lý lời mời. Với request đến, hiển thị Xóa/Chấp nhận thay vì bắt follow lại. Chỉ gợi ý Follow khi người dùng cần khởi tạo lời nhắn và chưa có quyền từ việc chấp nhận. Không tạo chat chỉ vì mở hồ sơ. Request đã xóa hoàn toàn ở phía người nhận trả `conversationId=null` tại contact và `404` khi đọc trực tiếp ID cũ; nếu có tin mới, ID đó xuất hiện lại nhưng chỉ đọc được phần lịch sử mới.

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

FE tạo `crypto.randomUUID()` cho mỗi tin mới. Khi request mất mạng hoặc mất phản hồi sau khi server đã ghi, giữ lại nội dung và **dùng lại UUID đó với cùng nội dung**. BE trả lại cùng tin nhắn, không tăng sequence, không tạo thêm unread/event. Dùng lại UUID với nội dung khác trả `409 MESSAGE_ID_CONFLICT`. Chỉnh nội dung là một lần gửi mới với UUID mới. Quyền gửi từ Follow hoặc chấp nhận và trạng thái tài khoản vẫn được kiểm tra lại khi retry.

### Chấp nhận hoặc xóa lời mời đến

`POST /messaging/conversations/:id/accept` không cần body. Response là Conversation với `box=friends`, `canSend=true`, `canAcceptRequest=false`, `canDeleteRequest=false` nếu peer còn ACTIVE. Retry sau khi đã chấp nhận không tạo thêm event. Chấp nhận không ghi Follow và vẫn có hiệu lực khi unfollow.

`DELETE /messaging/conversations/:id/request` nhận body:

```json
{ "throughMessageId": "d06868ca-59cb-483f-ac14-59db9cfc4f4f" }
```

FE truyền ID tin mới nhất **đã hiển thị trong lịch sử**, không tự chọn tin mới chưa tải/hiển thị. Response `{ conversationId, deletedThroughSequence }` ghi cutoff chỉ cho người nhận. Lịch sử phía người gửi giữ nguyên và dữ liệu message không bị xóa toàn cục. Request biến mất nếu không còn tin sau cutoff; tin mới sau đó xuất hiện lại trong `requests` với lịch sử mới và unread tương ứng. Retry cùng marker không ẩn nhầm tin mới hơn. Cursor/tin nằm trước cutoff không còn đọc hoặc mark-read được ở phía người đã xóa.

Chỉ người nhận của request được xử lý lần đầu. Người gửi không thể tự chấp nhận/xóa ở phía người kia; admin hoặc người ngoài trả `404`. Không xóa request đã chấp nhận hoặc đã là bạn bè: `409 MESSAGE_REQUEST_NOT_PENDING`. Các thao tác dùng cùng transaction/user locks với gửi tin và thay đổi tài khoản. Xóa không tạo read receipt hoặc tự đánh dấu đã xem ở phía người gửi.

Không tự hiển thị tin như đã gửi trước khi có xác nhận từ API. Gộp response POST và GET theo `message.id` để tránh trùng. Server bảo đảm một cuộc trò chuyện cho một cặp người dùng, kể cả khi hai bên gửi đồng thời.

### Danh sách và phân trang

Cả inbox và lịch sử dùng `{ "items": [], "nextCursor": null }`. `limit` mặc định 20, từ 1 đến 50. Bỏ `cursor` ở trang đầu, dùng nguyên `nextCursor` ở trang sau. `null` nghĩa là hết trang.

Inbox được lọc theo `box` trước khi phân trang và sắp theo hoạt động gần nhất giảm dần, có ID làm khóa phụ. Mỗi item:

```ts
type Conversation = {
  id: string;
  peer: {
    id: string;
    username: string;
    fullName: string;
    avatarUrl: string | null;
    isProfessional: boolean;
  };
  box: 'friends' | 'requests';
  requestDirection: 'incoming' | 'outgoing' | null;
  followsPeer: boolean;
  peerFollowsYou: boolean;
  canSend: boolean;
  canAcceptRequest: boolean;
  canDeleteRequest: boolean;
  deletedThroughSequence: number;
  lastMessage: {
    id: string;
    senderId: string;
    body: string;
    createdAt: string;
  } | null;
  unreadCount: number;
  myReadSequence: number;
  peerReadSequence: number;
};
```

`requestDirection` là `incoming` với người nhận của cuộc trò chuyện chưa chấp nhận, `outgoing` với người mở đầu, `null` khi ở mục bạn bè. Hướng này được giữ sau unfollow. Sau gửi tin, đổi Follow hoặc xử lý request, FE tải lại inbox từ trang đầu để bỏ cursor cũ. Cursor inbox chuyển hộp thư trả `400 MESSAGE_CURSOR_INVALID`; cursor không thuộc người gọi hoặc request đã ẩn hoàn toàn ở phía mình trả `404`. FE loại bỏ tin có `sequence <= deletedThroughSequence` khỏi cả cache lịch sử cũ và tin đã xác nhận cục bộ.

Lịch sử sắp `sequence DESC`, không phụ thuộc thời gian máy client. FE gộp các trang, loại trùng theo ID rồi hiển thị `sequence ASC`. Cursor là ID của tin cuối trang; cursor của cuộc trò chuyện khác hoặc không còn tồn tại trả `400 MESSAGE_CURSOR_INVALID`.

### Đã đọc

`PUT /messaging/conversations/:id/read` nhận `{ "messageId": "<UUID v4 của tin đã hiển thị>" }`, trả:

```json
{
  "conversationId": "eb96ee73-c9ba-486c-b9ca-33d06d135489",
  "readSequence": 1,
  "unreadCount": 0
}
```

Vị trí đọc chỉ tăng, không lùi. BE yêu cầu tin thực sự thuộc cuộc trò chuyện; không nhận sequence tùy ý. `unreadCount` chỉ tính tin đến sau vị trí đọc của chính mình. GET không tự đánh dấu đã đọc. FE hiện chỉ đánh dấu khi cuộc trò chuyện đang hiển thị, tab có focus và người dùng ở cuối lịch sử. Tin mình gửi có `sequence <= peerReadSequence` hiển thị “Đã xem”.

## Realtime bằng SSE

Client gửi tin qua POST và nhận thay đổi qua SSE. Dùng `fetchEventSource` với header Bearer; không đặt token trong URL. Một kết nối dùng chung cho layout `/home`, kể cả khi người dùng đang xem trang khác.

| Event                  | Payload                                              | Cách xử lý                                                            |
| ---------------------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| `stream.ready`         | `{}`                                                 | Đã kết nối change stream; đồng bộ lại inbox, chi tiết và lịch sử      |
| `stream.unavailable`   | `{}`                                                 | Bật polling GET trong lúc chờ khôi phục                               |
| `message.created`      | Metadata bên dưới                                    | Tải lại inbox, chi tiết và lịch sử chat liên quan                     |
| `conversation.read`    | Metadata bên dưới                                    | Tải lại unread và vị trí đã đọc                                       |
| `relationship.changed` | Metadata bên dưới, các field có thể null             | Tải lại quyền gửi, inbox từ trang đầu và thông tin contact            |
| `request.accepted`     | Metadata với `conversationId`                        | Cả hai phía tải lại inbox/contact; cuộc trò chuyện chuyển sang bạn bè |
| `request.deleted`      | Metadata với `conversationId`, chỉ gửi cho người xóa | Bỏ cache lịch sử cũ, reset inbox và đóng thread đã xóa                |
| `ping`                 | `{ "connected": true }` hoặc `false`                 | Heartbeat mỗi 15 giây; phản ánh tình trạng change stream              |
| `session.expired`      | `{}`                                                 | Ngắt stream, refresh phiên hoặc đăng nhập lại                         |

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
- Thay đổi theo dõi, gửi, đọc, chấp nhận và xóa lời mời dùng cùng thứ tự khóa user với quản trị tài khoản để tránh race khi thao tác đồng thời.

Mongoose đăng ký collection/index khi khởi động; không có Prisma migration. Reverse proxy cần cho phép SSE chạy lâu và không buffer response (`X-Accel-Buffering: no` đã được đặt ở API).

## Frontend đã tích hợp

- Trang `/home/messages`: inbox bạn bè/tin nhắn lạ, unread, lịch sử phân trang, composer và read receipt; bố cục desktop hai cột và mobile quay lại hộp thư.
- `/home/messages?to=<userId>` mở từ nút “Nhắn tin” trên hồ sơ; `?conversation=<id>` mở chat có sẵn.
- `features/messaging/schemas.ts`, `lib/messaging-api.ts`: contract Zod và API client.
- `hooks/use-messaging.ts`, `hooks/use-messaging-stream.ts`: cache theo access token, GET/SSE, reconcile khi reconnect.
- `components/messages-view.tsx`: UI; `components/messaging-stream.tsx` gắn tại home layout.
- Hook follow hiện có làm mới quyền chat và inbox ngay sau thay đổi quan hệ.

## Mã lỗi và kiểm thử

| HTTP | Code                                                      | FE xử lý                                                                |
| ---- | --------------------------------------------------------- | ----------------------------------------------------------------------- |
| 400  | `VALIDATION_FAILED`                                       | Tin rỗng/quá dài, UUID hoặc limit sai                                   |
| 400  | `SELF_MESSAGE_NOT_ALLOWED`                                | Không nhắn cho chính mình                                               |
| 400  | `MESSAGE_CURSOR_INVALID`                                  | Bỏ cursor, tải lại trang đầu                                            |
| 401  | `UNAUTHORIZED`, `ACCOUNT_SUSPENDED`, `ACCOUNT_NOT_ACTIVE` | Refresh phiên/đăng nhập lại                                             |
| 403  | `MESSAGE_FOLLOW_REQUIRED`                                 | Cần Follow để bắt đầu lời nhắn hoặc chấp nhận lời mời đến để trả lời    |
| 403  | `MESSAGE_REQUEST_RECEIVER_REQUIRED`                       | Chỉ người nhận được xử lý lời mời, không tự chấp nhận lời mời gửi đi    |
| 404  | `NOT_FOUND`                                               | Người nhận không khả dụng hoặc chat/tin không thuộc người gọi           |
| 409  | `MESSAGE_ID_CONFLICT`                                     | UUID đã dùng cho nội dung khác; không retry mù                          |
| 409  | `MESSAGE_REQUEST_NOT_PENDING`                             | Không xóa cuộc trò chuyện đã chấp nhận/đã là bạn bè; tải lại trạng thái |
| 409  | `CONFLICT`                                                | Xung đột ghi đồng thời còn tồn tại sau retry; giữ nội dung để thử lại   |

Chạy `npm run test:e2e -- test/e2e/messaging.e2e-spec.ts test/e2e/messaging-notifications.flows.e2e-spec.ts` với MongoDB local replica set. Suite dùng database ngẫu nhiên, tạo index và tự xóa database sau test. Bao phủ phân loại inbox, quyền admin/user, giới hạn nội dung, cursor, đồng thời, idempotency, unread, follow/unfollow, xử lý lời mời, xóa tài khoản, stream riêng tư, nhiều instance và JWT hết hạn/đình chỉ. Test không ghi vào database ứng dụng.

Follow-up Xóa/Chấp nhận đã qua 37 unit tests của messaging, 83 E2E HTTP/MongoDB/SSE, build và ESLint. Production Docker image build và API smoke cũng đạt: quyền chỉ người nhận, không tạo Follow, gửi hai chiều sau unfollow, xóa riêng phía người nhận, tin mới xuất hiện lại, retry marker không xóa tin mới, cursor/read cũ bị từ chối. FE có 18 browser tests riêng với mock API. Không có thay đổi env hoặc migration bắt buộc; chưa merge/deploy khi ghi nhận kiểm tra này.
