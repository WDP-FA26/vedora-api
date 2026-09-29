# Profile, Follow và Followers — API cho frontend

Base URL lấy từ cấu hình frontend (`NEXT_PUBLIC_API_URL`), ví dụ local:
`http://localhost:4000/api/v1`. Các URL dưới đây tính từ base URL này.

## Phạm vi và quyền truy cập

- Profile công khai chỉ gồm thông tin hiển thị; **không có email, role, dữ liệu đăng nhập hoặc Dietary Profile**.
- Guest xem được profile, danh sách followers/following và feed bài đăng đã `PUBLISHED`.
- Các thao tác chỉnh sửa, upload ảnh, Follow/Unfollow và xem quan hệ Follow cần `Authorization: Bearer <accessToken>`.
- URL frontend nên dùng `/profile/<userId>` vì ID ổn định khi `username` thay đổi. `@username` là tên hiển thị.
- Tài khoản chưa xác minh email không có profile công khai (`404`).

## Kiểu dữ liệu

```ts
type ProfileSummary = {
  id: string; // UUID v4
  username: string;
  fullName: string;
  bio: string | null;
  avatarUrl: string | null;
  coverUrl: string | null;
};

type Profile = ProfileSummary & {
  createdAt: string; // ISO 8601
  postCount: number; // chỉ bài PUBLISHED
  followerCount: number;
  followingCount: number;
};

type ProfileList = {
  items: ProfileSummary[];
  nextCursor: string | null;
};
```

Không dùng object từ `/auth/me` để render profile người khác vì nó có `email` và `role`.

## Đọc profile và bài đăng

| Method | Endpoint                       | Auth  | Kết quả                                      |
| ------ | ------------------------------ | ----- | -------------------------------------------- |
| `GET`  | `/profiles/:id`                | Không | `Profile`                                    |
| `GET`  | `/profiles/me`                 | Có    | `Profile` của người gọi                      |
| `GET`  | `/profiles/:id/relationship`   | Có    | `{ "isFollowing": boolean }`                 |
| `GET`  | `/posts?authorId=:id&limit=20` | Không | `{ items, nextCursor }`, chỉ bài `PUBLISHED` |

Trang của người khác gọi `/profiles/:id`; nếu đã đăng nhập, gọi thêm
`/profiles/:id/relationship` để đặt trạng thái nút Follow. Với trang của mình,
dùng ID từ `/auth/me` và ẩn nút Follow. `GET /posts/:id` vẫn yêu cầu đăng nhập
vì tác giả cần poll bài đang xử lý; feed công khai dùng `GET /posts`.
`author` của mỗi bài có thêm `avatarUrl: string | null` để hiển thị ảnh tác giả
trên feed.

## Followers và following

| Method | Endpoint                                         | Auth  | Kết quả       |
| ------ | ------------------------------------------------ | ----- | ------------- |
| `GET`  | `/profiles/:id/followers?limit=20&cursor=<uuid>` | Không | `ProfileList` |
| `GET`  | `/profiles/:id/following?limit=20&cursor=<uuid>` | Không | `ProfileList` |

`limit` mặc định 20, hợp lệ từ 1 đến 50. Lần đầu bỏ `cursor`; lần sau gửi
`nextCursor` nhận từ response trước. `nextCursor: null` nghĩa là hết danh sách.
Danh sách sắp xếp theo thời điểm Follow mới nhất trước. Khi Follow/Unfollow,
tải lại số đếm và danh sách đang mở để đồng bộ với server.

## Follow/Unfollow

| Method   | Endpoint               | Auth | Thành công           |
| -------- | ---------------------- | ---- | -------------------- |
| `PUT`    | `/profiles/:id/follow` | Có   | `204`, không có body |
| `DELETE` | `/profiles/:id/follow` | Có   | `204`, không có body |

Hai thao tác có tính idempotent: Follow một tài khoản đã theo dõi hoặc bỏ theo
dõi tài khoản chưa theo dõi đều thành công. Không thể Follow chính mình (`400`).
ID không tồn tại hoặc chưa xác minh trả `404`. Guest bấm Follow nên được dẫn tới
đăng nhập rồi quay lại trang profile.

## Chỉnh sửa hồ sơ

`PATCH /profiles/me` cần Bearer token. Body nhận một hoặc cả hai trường:

```json
{
  "fullName": "Nguyễn An",
  "bio": "Thích nấu món chay dễ làm."
}
```

`fullName` sau khi bỏ khoảng trắng đầu/cuối phải có nội dung, tối đa 100 ký tự.
`bio` tối đa 500 ký tự; gửi `"bio": ""` để xóa. Response là `Profile` mới.
Endpoint này không sửa `username`, `email`, `role` hoặc Dietary Profile. Field
không khai báo bị từ chối `400`.

## Avatar và ảnh bìa bằng Vercel Blob

Ảnh profile hiện dùng chung `BLOB_READ_WRITE_TOKEN` và `BLOB_CALLBACK_URL` với
PDF kiến thức. Code upload ảnh yêu cầu `access: 'public'`, còn PDF yêu cầu
`access: 'private'`. Vercel Blob chọn quyền truy cập khi tạo **store**, vì vậy
**một token của một store không thể đáp ứng đồng thời hai luồng này**. Nếu token
trỏ tới store Private, bước `put` ảnh trên FE sẽ bị Vercel từ chối; nếu trỏ tới
store Public, luồng PDF Private sẽ không hoạt động. Backend cần dùng hai store
hoặc phục vụ ảnh qua API từ store Private trước khi cả hai tính năng có thể hoạt
động cùng lúc. API hiện chưa kiểm tra trước loại store để trả `503`; FE cần xử lý
lỗi từ lệnh `put`.

Chỉ tài khoản đăng nhập được upload. Nhận JPEG, PNG, WebP; avatar tối đa 5 MiB,
ảnh bìa tối đa 10 MiB. FE nên crop/resize trước khi gửi.

1. Gọi `POST /profiles/me/images/uploads`:

   ```json
   { "kind": "AVATAR", "contentType": "image/webp", "sizeBytes": 145000 }
   ```

   Dùng `kind: "COVER"` cho ảnh bìa. Response `201`:

   ```json
   {
     "id": "b7f6f651-b0fc-43a5-b589-edbda60e5983",
     "pathname": "profiles/<userId>/avatar/b7f6f651-b0fc-43a5-b589-edbda60e5983.webp",
     "clientToken": "..."
   }
   ```

2. Trong trình duyệt, dùng `@vercel/blob/client`:

   ```ts
   import { put } from '@vercel/blob/client';

   await put(pathname, file, {
     access: 'public',
     token: clientToken,
     contentType: file.type,
   });
   ```

3. Vercel Blob gọi callback tới backend để xác nhận upload. Sau khi `put`
   thành công, gọi `POST /profiles/me/images/:uploadId/activate`. Nếu nhận
   `409` vì callback chưa tới, đợi ngắn rồi thử lại; chỉ thử trong 24 giờ kể
   từ lúc xin token. Response `200` là `Profile` mới với `avatarUrl` hoặc
   `coverUrl` đã cập nhật. FE chỉ lưu URL do API trả về, không gửi URL bất kỳ
   để cập nhật profile.

4. Muốn bỏ ảnh hiện tại: `DELETE /profiles/me/images/AVATAR` hoặc
   `/profiles/me/images/COVER`. Response `200` là `Profile` mới với URL tương
   ứng bằng `null`.

Token upload hết hạn sau 1 giờ. Upload chưa kích hoạt và ảnh cũ được dọn nền
sau ít nhất 48 giờ. Ảnh đã công khai có thể còn được cache trong thời gian đó.

## Trạng thái lỗi quan trọng

| Status | Trường hợp                                                                  |
| ------ | --------------------------------------------------------------------------- |
| `400`  | UUID/query/body sai; tự Follow; loại ảnh không hỗ trợ                       |
| `401`  | Thiếu hoặc sai access token trên endpoint cần đăng nhập                     |
| `404`  | Profile không tồn tại/chưa xác minh; upload không thuộc người gọi           |
| `409`  | Kích hoạt upload chưa được callback xác nhận hoặc đã quá 24 giờ             |
| `413`  | Kích thước ảnh vượt giới hạn                                                |
| `503`  | Thiếu `BLOB_READ_WRITE_TOKEN` hoặc `BLOB_CALLBACK_URL` khi xin token upload |

## Cấu hình backend cần có

Không còn biến `PROFILE_BLOB_READ_WRITE_TOKEN` hoặc `PROFILE_BLOB_CALLBACK_URL`.
`BLOB_READ_WRITE_TOKEN` lấy từ Vercel dashboard → Storage → Blob → cấu hình store.
`BLOB_CALLBACK_URL` không phải giá trị lấy từ Vercel: đặt bằng URL public đầy đủ
của API, ví dụ `https://api.example.com/api/v1/webhooks/vercel-blob`. Endpoint
này nhận callback cho cả ảnh profile và PDF; FE không gọi trực tiếp. Local cần
tunnel HTTPS tới API rồi dùng URL tunnel kèm `/api/v1/webhooks/vercel-blob`, vì
Vercel không thể gọi `localhost`. Không đưa token store lên frontend; FE chỉ nhận
client token giới hạn cho đúng ảnh từ API.
