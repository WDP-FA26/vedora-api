# Comment và like bài đăng

Base URL: `/api/v1`. Các API ghi dữ liệu yêu cầu header
`Authorization: Bearer <accessToken>`. Backend lấy danh tính từ token và quyền hiện
tại từ database; frontend không gửi `authorId`, `userId` hoặc `role`.

Chỉ bài `PUBLISHED` nhận comment/like và cho phép đọc danh sách comment.
Bài không tồn tại, `PROCESSING` hoặc `FAILED` đều trả HTTP 404 cho các API tương tác,
kể cả khi người gọi là chủ bài đăng. Người dùng có thể like bài của chính mình.

## API

| Method   | Endpoint                             | Body                         | Thành công                  | Đăng nhập      |
| -------- | ------------------------------------ | ---------------------------- | --------------------------- | -------------- |
| `GET`    | `/posts/:postId/comments`            | —                            | 200 `{ items, nextCursor }` | Không bắt buộc |
| `POST`   | `/posts/:postId/comments`            | `{ "body": "Nội dung" }`     | 201 comment                 | Có             |
| `PATCH`  | `/posts/:postId/comments/:commentId` | `{ "body": "Nội dung mới" }` | 200 comment                 | Có             |
| `DELETE` | `/posts/:postId/comments/:commentId` | —                            | 204, không có body          | Có             |
| `PUT`    | `/posts/:postId/like`                | —                            | 200 trạng thái like         | Có             |
| `DELETE` | `/posts/:postId/like`                | —                            | 200 trạng thái like         | Có             |

## Comment

Nội dung là plain text, bắt buộc, tối đa **1000 ký tự** sau khi trim khoảng trắng
ở hai đầu. Nội dung rỗng hoặc chỉ có khoảng trắng không hợp lệ. API không nhận HTML
theo một định dạng riêng; frontend hiển thị như văn bản, không chèn trực tiếp vào HTML.

Ví dụ tạo comment:

```http
POST /api/v1/posts/11111111-1111-4111-8111-111111111111/comments
Authorization: Bearer <accessToken>
Content-Type: application/json

{"body":"Bài viết hữu ích!"}
```

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "postId": "11111111-1111-4111-8111-111111111111",
  "body": "Bài viết hữu ích!",
  "author": {
    "id": "33333333-3333-4333-8333-333333333333",
    "username": "vedora.user",
    "fullName": "Vedora User",
    "avatarUrl": null
  },
  "createdAt": "2026-10-02T08:00:00.000Z",
  "updatedAt": "2026-10-02T08:00:00.000Z"
}
```

Quyền thao tác:

- Sửa: chỉ người viết comment. Chủ bài đăng và admin không sửa nội dung của người khác.
- Xóa: người viết comment, chủ bài đăng hoặc admin.
- `commentId` phải thuộc đúng `postId` trên URL; ID thuộc bài khác trả 404.
- Xóa một comment đã bị xóa trả 404.

Danh sách dùng thành phần cursor pagination chung:

```http
GET /api/v1/posts/:postId/comments?limit=20
GET /api/v1/posts/:postId/comments?limit=20&cursor=<nextCursor>
```

- `limit` mặc định 20, số nguyên từ 1 đến 50.
- `cursor` là UUID v4 từ `nextCursor` của trang trước.
- Sắp xếp mới nhất trước: `createdAt DESC`, rồi `id DESC` để phân định khi trùng thời điểm.
- Response `{ "items": [/* comment */], "nextCursor": "..." }`.
- Khi hết dữ liệu hoặc chưa có comment: `nextCursor: null`; danh sách rỗng có `items: []`.
- Cursor đã bị xóa hoặc thuộc bài khác: HTTP 400. Khi gặp trường hợp này, tải lại trang đầu.
- Không gửi `page`; các trường query không khai báo bị từ chối.

Phiên bản này là comment trực tiếp vào bài đăng, chưa có thread/reply-to-comment,
media trong comment hoặc like comment. `parentId` không được nhận.

Tạo comment không có khóa chống gửi trùng: frontend nên khóa nút gửi trong lúc request
đang chạy. Nếu request bị timeout, tải lại danh sách trước khi quyết định gửi lại.

## Like / unlike

Mỗi cặp `(postId, userId)` có tối đa một like. Dùng hai API riêng để đặt trạng thái:

```http
PUT /api/v1/posts/:postId/like
Authorization: Bearer <accessToken>
```

```json
{
  "postId": "11111111-1111-4111-8111-111111111111",
  "isLiked": true,
  "likeCount": 12
}
```

Unlike dùng `DELETE` cùng URL, trả cùng cấu trúc với `isLiked: false` và số lượng
like hiện tại. **Unlike trả JSON HTTP 200**, khác với xóa comment trả 204.

Gọi lặp `PUT` khi đã like không tăng thêm like; gọi lặp `DELETE` khi chưa like vẫn
thành công. Unique key trong database bảo vệ cả trường hợp nhiều request like đồng thời.
API unlike chỉ xóa like của người đang đăng nhập.

Frontend nên chỉ cho một request like/unlike đang chạy trên một bài đăng tại một thời
điểm để tránh phản hồi đến sai thứ tự. Dùng `isLiked` và `likeCount` từ response để cập
nhật giao diện; khi request lỗi, hoàn tác optimistic update hoặc revalidate bài đăng.

## Response bài đăng được bổ sung

`POST /posts`, `GET /posts` và `GET /posts/:id` trả thêm:

```ts
interface PostInteractionFields {
  commentCount: number;
  likeCount: number;
  isLiked: boolean;
}
```

`GET /posts` vẫn cho đọc công khai. Không gửi token: `isLiked` luôn false. Gửi token
hợp lệ: `isLiked` đúng theo tài khoản đó. Token được gửi nhưng không hợp lệ/hết hạn hoặc
tài khoản đã bị xóa: HTTP 401; frontend refresh token rồi tải lại.
`GET /posts/:id` vẫn yêu cầu đăng nhập như trước.

Các số đếm được tính từ bản ghi hiện có, không lưu counter riêng. Khi xóa bài đăng,
database tự xóa comment và like; khi xóa tài khoản, database xóa comment/like của tài
khoản đó. Số đếm có thể thay đổi giữa các request khi người khác tương tác.

Sau tạo/xóa comment, frontend cập nhật danh sách comment và revalidate bài đăng để lấy
`commentCount` mới. Sửa comment không thay đổi số lượng. Response comment không kèm
số đếm của bài đăng.

Frontend đã bổ sung ba trường này vào `apiPostSchema` và ánh xạ trong `toFeedPost`:

| API            | Giao diện hiện tại   |
| -------------- | -------------------- |
| `commentCount` | `post.stats.replies` |
| `likeCount`    | `post.stats.likes`   |
| `isLiked`      | `post.liked`         |

Frontend đã tích hợp:

- `features/posts/lib/posts-api.ts`: fetch danh sách, tạo/sửa/xóa comment, like/unlike;
  kiểm tra response bằng Zod.
- `features/posts/hooks/use-post-interactions.ts`: dùng access token từ `useAuth`,
  cập nhật cache feed/chi tiết; HTTP 401 gọi `router.refresh()` theo luồng refresh token hiện tại.
- `features/posts/hooks/use-comments.ts`: tải thêm bằng cursor; tạo/xóa/sửa comment
  tải lại từ trang đầu để tránh giữ cursor đã bị xóa.
- `features/posts/components/post-comments-dialog.tsx`: hộp bình luận, nội dung tối đa
  1000 ký tự, nút sửa/xóa theo quyền, xác nhận xóa và hiển thị lỗi/tải lại.
- `features/home/components/post-card.tsx`: nút phản hồi mở hộp bình luận; nút thích
  gọi API và lấy số đếm từ response. Khóa thao tác trong lúc gửi để tránh request trùng.

Chỉ bài thật từ API đã `PUBLISHED` bật comment/like. Các bài mẫu minh họa và bài chưa
xuất bản không gửi request tương tác. API thất bại không làm tăng số like trên giao diện.

## Lỗi và triển khai

| HTTP | Trường hợp                                                                           |
| ---- | ------------------------------------------------------------------------------------ |
| 400  | UUID sai, body/query không hợp lệ, body quá dài/rỗng, cursor không thuộc bài         |
| 401  | API ghi thiếu token; token được xác thực nhưng không hợp lệ/hết hạn/tài khoản đã xóa |
| 403  | Không có quyền sửa/xóa comment                                                       |
| 404  | Bài chưa xuất bản/không tồn tại, comment không tồn tại hoặc thuộc bài khác           |

Lỗi dùng cấu trúc `{ statusCode, code, message, details? }`, xem [errors.md](errors.md).
Validation trả `code: VALIDATION_FAILED` với các thông báo trong `details.messages`.
Không có mã lỗi nghiệp vụ mới.

Migration mới: `20261002000000_post_comments_and_likes`. Áp dụng trước khi chạy bản API mới:

```bash
npm run start:dev    # Mongoose tự tạo collection/index khi khởi động
npm run build
```

Container production đã chạy migration trước khi khởi động. Không cần biến môi trường
hoặc dependency mới cho tính năng này. Swagger tại `/docs` có request/response của các endpoint.
