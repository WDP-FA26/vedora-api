# Bản nháp bài viết và video

## Hành vi

Video tải lên gắn với một bài `DRAFT` riêng tư. Đóng form hoặc chuyển trang trong ứng dụng không hủy upload. F5 hoặc đóng tab làm dừng request của trình duyệt; khi mở lại Vedora bằng **cùng tài khoản, trình duyệt và thiết bị**, FE đọc lại file đã lưu trong IndexedDB và tự thử tải lại. File đang tải dở được gửi lại từ đầu, chưa hỗ trợ tiếp tục từ byte cuối cùng.

File đã tải xong được giữ trên Cloudinary và gắn với nháp trên MongoDB. Có thể mở nháp đó trên thiết bị khác. File chưa tải xong chỉ có trên thiết bị ban đầu. Xóa dữ liệu website, chế độ riêng tư, hết dung lượng hoặc trình duyệt thu hồi bộ nhớ có thể làm mất file chưa đồng bộ; FE phải hiển thị lỗi lưu, không khẳng định nháp đã an toàn.

Không tự xuất bản khi upload, mã hóa video, webhook hoặc tác vụ bảo trì hoàn tất. Chỉ `POST /posts/drafts/:id/publish` sau thao tác **Đăng** của người dùng mới chuyển bài sang `PROCESSING`. Kiểm duyệt và phụ đề tiếp tục dùng luồng hiện có. `PROCESSING`, `PENDING_REVIEW`, `REJECTED`, `FAILED` không được thêm vào bảng tin công khai.

## API

Prefix mặc định `/api/v1`. Mọi route bên dưới yêu cầu Bearer token của chủ nháp. Nháp của người khác trả 404. Response đặt `Cache-Control: private, no-store` và `Vary: Authorization`.

| Method | Route | Body / kết quả |
| --- | --- | --- |
| GET | `/posts/drafts` | `{ items: PostDraft[] }`; chỉ nháp bài ngắn/video của chủ tài khoản, không gồm blog |
| POST | `/posts/drafts` | `{ id: UUIDv4, kind: "POST" \| "VIDEO" }`; 201, tạo idempotent theo ID phía client |
| GET | `/posts/drafts/:id` | `PostDraft`; dùng để khôi phục/sửa; khi tắt webhook, BE đối soát media đang chờ |
| PATCH | `/posts/drafts/:id` | `{ expectedVersion, body?, title?, description? }`; trả nháp mới |
| POST | `/posts/drafts/:id/uploads` | `{ mediaId: UUIDv4 }`; 201 `{ draft, media, upload }` |
| DELETE | `/posts/drafts/:id/media/:mediaId` | `{ expectedVersion }`; gỡ media, trả nháp mới |
| POST | `/posts/drafts/:id/publish` | `{ expectedVersion }`; 200 `PostResponse`, không tạo bài mới khi retry |
| DELETE | `/posts/drafts/:id` | 204; xóa nháp, đánh dấu media để luồng dọn dẹp hiện có xử lý |

`PostDraft` gồm `id`, `kind`, `body`, `title`, `description`, `version`, `updatedAt`, `media` (cùng cấu trúc `/media`). `upload` dùng cùng signed fields và chunk size với uploader Cloudinary hiện có; bằng `null` nếu media đã nhận đủ file hoặc sẵn sàng. Giữ nguyên `mediaId` khi retry/F5 để không tạo attachment trùng. BE kiểm tra media thuộc đúng tài khoản và nháp.

`version` tăng khi thay đổi nội dung hoặc thêm/gỡ media. Dùng version mới nhất để lưu/gỡ/đăng. 409 nghĩa là nháp đã đổi ở phiên khác; không tự ghi đè nội dung bên kia. Lưu lại đúng cùng nội dung hoặc gỡ lại media đã gỡ được chấp nhận để xử lý mất response.

Upload chưa xong (`WAITING_UPLOAD`) hoặc lỗi (`FAILED`) chặn đăng. Có thể đăng khi media `PROCESSING` hoặc `READY`; bài vẫn phải chờ mã hóa và kiểm duyệt. Video guide cần tiêu đề, mô tả và đúng một video. Bài ngắn tối đa `POST_MAX_MEDIA` video, mặc định 4. Giới hạn nội dung/thời lượng dùng lại cấu hình hiện có: mặc định 250 từ, 2.000 ký tự và 180 giây.

## Lưu trữ FE

- `PostDraftProvider` ở root layout giữ upload độc lập với form và route. Session bridge cấp token trong bộ nhớ, không lưu token vào IndexedDB.
- Database `vedora-post-drafts`: store `drafts` chứa nội dung/trạng thái, store `files` chứa `File`. Khóa có ID tài khoản; đăng xuất dừng request, tài khoản khác không tự đọc/tải file này.
- Commit file và metadata vào IndexedDB trước khi upload. Trong lúc đang ghi, cảnh báo rời trang giúp tránh đóng tab trước khi file kịp lưu. Nếu lưu lỗi thì dừng queue và báo lỗi.
- `/home/drafts` liệt kê nháp; `/home/drafts/:id` chỉnh sửa và đăng. Xóa nháp là thao tác riêng có xác nhận; đóng form giữ nháp.
- Nếu đã bấm Đăng nhưng mất response, FE giữ ý định đăng để retry và đối soát theo ID bài. Nháp chưa từng bấm Đăng không tự đăng sau reload.
- File cục bộ được giữ đến khi đăng hoặc xóa nháp. Nếu upload hết hạn (`UPLOAD_TIMED_OUT`), gỡ media cũ và xin ID mới; lỗi nội dung/video cần sửa hoặc chọn file khác.

## Triển khai và cấu hình

Triển khai BE có API mới trước FE. Không cần service worker, Redis hay background queue mới. Mongoose bổ sung field với default; không có migration Prisma.

Biến mới **không bắt buộc**:

```dotenv
POST_MAX_DRAFTS_PER_USER=20
```

Mặc định 20 nháp bài ngắn/video mỗi tài khoản. Vượt giới hạn trả 429 `UPLOAD_LIMIT_REACHED`. Không tính blog vào quota này. Nháp không tự hết hạn; media còn gắn với nháp không bị job xóa upload mồ côi xóa đi. Người dùng chủ động đăng/xóa để giải phóng quota.

## Kiểm tra

- BE: `test/e2e/post-drafts.e2e-spec.ts`; dùng Mongo replica set riêng, Cloudinary và bộ đánh giá AI giả lập. Kiểm tra auth/owner/feed, retry, version, attachment, publish, xóa và giữ DRAFT khi settle media.
- FE: `playwright.drafts.config.ts`, `e2e/drafts/video-drafts.spec.ts`; Chromium, API/upload giả lập có giữ request giữa chừng. Kiểm tra chuyển trang, F5, đóng/mở tab, nội dung sửa trong lúc tải, đổi tài khoản, lỗi IndexedDB, publish lỗi và video guide trên mobile.
- Docker production image được smoke test với Mongo thật và webhook upload có chữ ký bằng thông tin giả lập. Kiểm tra dừng ở `PROCESSING`; không upload Cloudinary thật hay gọi AI trả phí. Chưa phải xác nhận end-to-end với dịch vụ Cloudinary production.
