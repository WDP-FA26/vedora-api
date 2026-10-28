# Blog công thức dài

Base URL: `/api/v1`. Blog dùng cùng `id` với `Post`: mọi comment, like,
bookmark, repost, report và view dùng `/posts/:id/...` hiện có.

## API

| Method | Endpoint      | Quyền             | Kết quả                                   |
| ------ | ------------- | ----------------- | ----------------------------------------- |
| POST   | `/blogs`      | Đăng nhập         | Tạo blog, mặc định `DRAFT`; HTTP 201      |
| GET    | `/blogs`      | Công khai         | Blog `PUBLISHED`, `{ items, nextCursor }` |
| GET    | `/blogs/mine` | Đăng nhập         | Blog của người gọi, gồm nháp              |
| GET    | `/blogs/:id`  | Công khai/tác giả | Chi tiết; nháp chỉ tác giả đọc được       |
| PATCH  | `/blogs/:id`  | Tác giả           | Sửa, xuất bản hoặc chuyển về nháp         |
| DELETE | `/blogs/:id`  | Tác giả           | Xóa blog và tương tác; HTTP 204           |

Gửi Bearer access token cho thao tác riêng. Token sai/hết hạn trên API đọc
cũng trả `401`, không tự chuyển sang guest. Người khác đọc/sửa/xóa nháp nhận
`404`; sửa/xóa blog của người khác cũng trả `404`. Admin dùng API quản lý
`/admin/posts` hiện có để liệt kê/xóa bài vi phạm.

## Tạo và sửa

```json
{
  "title": "Đậu hũ sốt cà cho bữa tối",
  "coverImageUrl": "https://example.com/dau-hu.jpg",
  "content": "## Chuẩn bị\nChọn đậu hũ và cà chua.\n\n## Cách làm\nNấu sốt rồi thêm đậu hũ.",
  "status": "DRAFT",
  "recipeIds": ["d1a2d3e4-0000-4000-8000-000000000001"]
}
```

- `title`: bắt buộc khi tạo, trim, 1–150 ký tự.
- `content`: Markdown, tối đa 50.000 ký tự; mặc định chuỗi rỗng cho nháp.
- `coverImageUrl`: HTTPS, tối đa 2048 ký tự, có thể bỏ qua hoặc `null`.
  Đây là link ảnh, backend không upload/tải ảnh hộ.
- `status`: chỉ `DRAFT` hoặc `PUBLISHED`, mặc định `DRAFT`.
- `recipeIds`: tối đa 10 UUID v4 khác nhau, phải có trong catalog; giữ thứ tự
  đầu vào. Bỏ qua khi tạo tương đương `[]`.

PATCH chỉ sửa field gửi lên. Field bỏ qua giữ nguyên; `coverImageUrl: null`
xóa ảnh bìa, `recipeIds: []` xóa toàn bộ liên kết. `content`, `title`,
`status`, `recipeIds` không nhận `null`. Body rỗng hoặc field lạ trả `400`.

Xuất bản nháp bằng `PATCH /blogs/:id` với `{"status":"PUBLISHED"}`. Nội dung
phải có ít nhất một ký tự sau trim; có thể gửi content và status trong cùng
lần PATCH. Nếu sửa bài đang công khai thành nội dung rỗng thì phải đồng thời
chuyển về `DRAFT`. API kiểm tra và cập nhật cả bài/liên kết trong transaction.

`publishedAt` được đặt khi xuất bản lần đầu. Sửa hoặc chuyển nháp rồi xuất bản
lại giữ thời gian này để không đẩy bài cũ lên đầu feed.

## Response và feed

Blog detail trả các field của [Post](post-comments-likes.md), thêm:

```ts
type BlogFields = {
  blog: {
    title: string;
    coverImageUrl: string | null;
    excerpt: string; // Tối đa 280 ký tự, preview văn bản nguồn.
    recipes: { id: string; title: string; imageUrl: string | null }[];
  };
  content: string; // Markdown đầy đủ, chỉ ở GET/POST/PATCH /blogs.
  updatedAt: string;
};
```

`GET /posts` nay trả cả `POST` và `BLOG` đã xuất bản. Dùng `?type=POST` cho
feed video/bài ngắn, `?type=BLOG` cho blog. `?authorId=<id>` tiếp tục lọc trang
cá nhân. `GET /blogs` hỗ trợ `authorId`, `cursor`, `limit`; không nhận `type`.

Mọi Post response thêm `blog`: `null` cho bài ngắn, object summary cho blog.
Danh sách, bookmark và `GET /posts/:id` không trả nội dung dài; FE gọi
`GET /blogs/:id` để mở bài. Trang cá nhân đếm blog đã xuất bản cùng các post.

`GET /blogs/mine` hỗ trợ `status=DRAFT|PUBLISHED`, `cursor`, `limit`, sắp xếp
`createdAt DESC, id DESC`; cursor phải thuộc người gọi và bộ lọc hiện tại.
Đổi bộ lọc thì bỏ cursor. Public feed sắp theo `publishedAt DESC, id DESC`.
Phân trang theo [cursor dùng chung](pagination.md), `limit` mặc định 20, tối đa 50.

Response đọc có xác thực và danh sách riêng có `Cache-Control: private, no-store`.
FE không chia sẻ cache nháp giữa tài khoản; xóa cache khi đăng xuất/đổi tài khoản.

## Hiển thị nội dung

Render `content` bằng Markdown với **raw HTML bị tắt**, escape HTML nguồn;
không dùng `dangerouslySetInnerHTML` cho chuỗi nguồn. Renderer cần chặn URL
`javascript:`/`data:` và chỉ cho phép scheme phù hợp của link/ảnh. `excerpt`
hiển thị như text, không render HTML/Markdown. Backend lưu văn bản nguồn,
không trả HTML đã render. JSON request tối đa 512 KiB để hỗ trợ UTF-8 dài.

## Ảnh và video trong bài

Nội dung vẫn là Markdown; ảnh/video chỉ là URL công khai trong văn bản.

| Method | Endpoint                | Quyền     | Kết quả                                       |
| ------ | ----------------------- | --------- | --------------------------------------------- |
| POST   | `/blogs/images/uploads` | Đăng nhập | Presigned PUT lên RustFS + `url` công khai    |
| POST   | `/blogs/videos/uploads` | Đăng nhập | Chữ ký upload Cloudinary + `url` MP4 công khai |

- Ảnh: body `{ "contentType": "image/jpeg|png|webp|gif", "sizeBytes": ≤ 5 MiB }`.
  PUT file thô tới `upload.url` kèm `upload.headers`, không gửi Authorization.
  Lưu bucket `STORAGE_BLOGS_BUCKET` (đọc công khai), không ghi DB; không có bước activate.
- Video: không body. POST multipart `upload.fields` + `file` tới `upload.url`
  (chia chunk nếu lớn hơn `chunkSize`, như `/media/uploads`). Video nằm ngoài
  luồng media của post nên không bị dọn orphan và không qua webhook/HLS.
- Chèn vào `content` bằng cú pháp ảnh: `![chú thích](url)`. Renderer coi URL có
  `/video/upload/` là video (`<video controls>`), còn lại là ảnh.
- File đã upload nhưng bị xóa khỏi bài chưa được dọn tự động.

## Liên kết món và tương tác

Hiển thị `blog.recipes` thành các món liên quan. Bấm món gọi
`GET /recipes/:id`; thêm vào thực đơn theo luồng
[preview → lưu](recipe-catalog-meal-plan.md). Liên kết blog không tự sửa công
thức, không tự thêm món vào thực đơn và không đổi bài nguồn `Recipe.postId`.
Xóa công thức chỉ gỡ liên kết, giữ blog; xóa blog giữ công thức catalog.

Comment/like/bookmark chỉ dùng khi blog `PUBLISHED`. Chuyển về nháp làm bài
biến mất khỏi feed và danh sách bookmark; tương tác cũ được giữ, hiển thị lại
khi xuất bản lại. Xóa blog xóa cả comment/like/bookmark và liên kết công thức.

## Lỗi

| HTTP | Trường hợp                                                              |
| ---- | ----------------------------------------------------------------------- |
| 400  | Body/query/UUID/cursor không hợp lệ                                     |
| 400  | `BLOG_CONTENT_REQUIRED`: xuất bản với nội dung rỗng                     |
| 400  | `BLOG_RECIPE_NOT_FOUND`: ID công thức không tồn tại; các ID lỗi trong `details.recipeIds` |
| 401  | Thiếu token trên thao tác riêng hoặc token gửi lên không hợp lệ         |
| 404  | Blog không tồn tại, là post thường hoặc không có quyền đọc/sửa/xóa      |

## Triển khai và kiểm thử

Cần migration `20261012000000_blogs` trước khi chạy phiên bản API mới.
Migration thêm trạng thái `DRAFT`, bảng `blogs` và `blog_recipes`; giữ nguyên
post và công thức hiện có. Nhánh Blog tách từ `feat/recipe-catalog`, cần cả
thay đổi catalog khi merge nếu nhánh đó chưa nằm trên main.

```bash
npm run start:dev    # Mongoose tự tạo collection/index khi khởi động
npm test
npm run test:e2e
npm run test:db
npm run build
npm run lint
```

`test:db` yêu cầu `TEST_DATABASE_URL` trỏ tới PostgreSQL test riêng; mỗi suite
tạo và xóa schema ngẫu nhiên. Không dùng database production cho test.
