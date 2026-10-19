# Tìm kiếm bài đăng

Base URL: `/api/v1`. Không bắt buộc đăng nhập; gửi `Authorization: Bearer <accessToken>`
để nhận `isLiked`, `isReposted`, `isBookmarked` của người xem.

## Giới hạn nội dung bài đăng

`POST /posts` nhận `body` là plain text, sau khi trim tối đa **250 từ** (từ = chuỗi
ký tự không có khoảng trắng, tách theo mọi loại khoảng trắng) và tối đa 2000 ký tự.
Vượt giới hạn trả `400` với message `body must be at most 250 words`. Frontend đếm từ
bằng cùng quy tắc (`countWords` trong `features/posts/schemas.ts`).

## API

| Method | Endpoint        | Query                          | Thành công                  |
| ------ | --------------- | ------------------------------ | --------------------------- |
| `GET`  | `/posts/search` | `q` (bắt buộc), `limit`, `cursor` | 200 `{ items, nextCursor }` |

- `q`: 1–200 ký tự sau trim, ngôn ngữ bất kỳ. Tìm theo **ý nghĩa** (embedding) và
  **từ khóa** (BM25, gõ không dấu vẫn khớp: `dau hu` tìm được "đậu hũ"). Câu hỏi
  tiếng Anh cũng tìm được bài tiếng Việt và ngược lại.
- `limit`: 1–50, mặc định 20.
- `cursor`: lấy từ `nextCursor` của trang trước, coi như chuỗi mờ (opaque). Kết quả
  sâu tối đa 200 bài; sau đó `nextCursor` là `null`.
- `items`: mảng `Post` giống `GET /posts`, xếp theo mức độ khớp (không theo thời gian).

Ví dụ:

```http
GET /api/v1/posts/search?q=b%C3%A1nh%20x%C3%A8o&limit=20
```

```json
{ "items": [{ "id": "…", "body": "Bánh xèo chay giòn rụm…", "…": "…" }], "nextCursor": null }
```

## Phạm vi và độ trễ

- Chỉ bài loại `POST` đã `PUBLISHED` và có nội dung văn bản. Bài chỉ có video không có
  chữ chưa tìm được. Blog chưa được hỗ trợ.
- Bài văn bản tìm được vài giây sau khi đăng. Bài có video được đánh chỉ mục khi video
  xử lý xong (tối đa khoảng 1 phút sau khi `PUBLISHED`).
- Bài đã xóa biến mất khỏi kết quả ngay.

## Lỗi

| HTTP | Khi nào                                                   |
| ---- | --------------------------------------------------------- |
| 400  | Thiếu `q`, `q` rỗng/quá dài, `limit` hoặc `cursor` sai    |
| 401  | Gửi token nhưng token không hợp lệ                        |
| 500  | Không gọi được dịch vụ embedding hoặc Qdrant              |
