# Đăng lại bài viết

Base URL: `/api/v1`. API ghi yêu cầu `Authorization: Bearer <accessToken>`; API đọc
danh sách đăng lại là công khai, gửi token nếu có để nhận trạng thái của chính mình.

## API

| Method   | Endpoint                     | Thành công                  | Đăng nhập      |
| -------- | ---------------------------- | --------------------------- | -------------- |
| `PUT`    | `/posts/:postId/repost`      | 200 trạng thái đăng lại     | Có             |
| `DELETE` | `/posts/:postId/repost`      | 200 trạng thái đăng lại     | Có             |
| `GET`    | `/posts/reposted-by/:userId` | 200 `{ items, nextCursor }` | Không bắt buộc |

## Đăng lại / hủy đăng lại

Mỗi người đăng lại một bài tối đa một lần. Cả `PUT` và `DELETE` chỉ chạy trên bài
`PUBLISHED`; bài khác trả 404. Hai API đều idempotent và trả:

```json
{
  "postId": "11111111-1111-4111-8111-111111111111",
  "isReposted": true,
  "repostCount": 3
}
```

Lần đăng lại đầu tiên gửi thông báo `REPOST` cho tác giả (trừ khi tự đăng lại bài mình).

## Danh sách bài đăng lại của một người

```http
GET /api/v1/posts/reposted-by/:userId?limit=20&cursor=<postId>
```

- Bài được đăng lại gần nhất đứng đầu. Mỗi item có cùng cấu trúc bài đăng như
  `GET /posts` (`author` là **tác giả gốc** của bài, không phải người đăng lại).
- `isLiked`, `isReposted`, `isBookmarked` là trạng thái của **người đang xem**: khách
  luôn nhận `false`; xem trang của người khác thì `isReposted` cho biết bạn có đăng lại
  bài đó hay không.
- `limit` 1–50, mặc định theo `PAGINATION_DEFAULT_LIMIT`. Gửi `nextCursor` qua `cursor`
  để lấy trang sau; `null` là hết. `nextCursor` là id bài của lượt đăng lại cuối trang,
  **có thể là bài bị ẩn không nằm trong `items`**, nên đừng giả định
  `nextCursor === items.at(-1).id`.
- Bài đã đăng lại nhưng không còn `PUBLISHED` (bị ẩn, chờ duyệt, đang sửa) bị bỏ qua, nên
  một trang **có thể ít hơn `limit` bài, kể cả rỗng, trong khi `nextCursor` vẫn khác
  `null`**. Frontend phải dựa vào `nextCursor`, không dựa vào số item, để biết còn trang.
- Bài bị xóa thì lượt đăng lại cũng bị xóa theo.

## Lỗi

| HTTP | `code`      | Khi nào                                                  |
| ---- | ----------- | -------------------------------------------------------- |
| 400  | —           | `userId` không phải UUID, hoặc `limit`/`cursor` sai dạng |
| 404  | `NOT_FOUND` | `GET`: không có hồ sơ công khai này (giống `GET /profiles/:id`); `PUT`/`DELETE`: bài không tồn tại hoặc chưa `PUBLISHED` |
| 401  | —           | Gửi token không hợp lệ vào API đọc; thiếu token ở API ghi |
