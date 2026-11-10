# Kiểm duyệt nội dung

Mọi nội dung người dùng đăng (bài viết, video, blog, bình luận) được model quyết định (mặc định `openai/gpt-6-luna-decisions` qua OpenRouter, xem `OPENROUTER_CONTENT_MODERATION_MODEL`) kiểm tra theo chính sách an toàn trước khi hiển thị. Chính sách chỉ xét an toàn, không xét chủ đề hay chế độ ăn.

## Bình luận

`POST` và `PATCH` bình luận kiểm duyệt đồng bộ:
- Vi phạm: HTTP 422, `code: CONTENT_REJECTED`, `details.category`. Bình luận không được lưu.
- Model lỗi hoặc quá thời gian: HTTP 503 `SERVICE_UNAVAILABLE`. Cho người dùng thử lại.

## Bài viết, video và blog

Jev trả về xác suất cho từng nhóm. Điểm vi phạm = `1 - P(allow)`:
- `>= MODERATION_REJECT_THRESHOLD` (mặc định 0.85): `REJECTED`.
- `>= MODERATION_REVIEW_THRESHOLD` (mặc định 0.3): `PENDING_REVIEW`, chờ admin quyết định. Chỉ tác giả thấy; `moderationVerdict` vẫn là `null` để không lộ điểm.
- Thấp hơn: `PUBLISHED`.

Bình luận không có hàng chờ nên chỉ bị chặn khi điểm `>= MODERATION_REJECT_THRESHOLD`.

Bài mới và blog xuất bản (hoặc sửa tiêu đề, nội dung, ảnh bìa của blog đã xuất bản) chuyển sang `PROCESSING` cho đến khi kiểm duyệt xong:
- Đạt: `PUBLISHED`.
- Vi phạm: `status: REJECTED` và `moderationVerdict` là category ở trên. Chỉ tác giả thấy. Sửa blog bị từ chối mà không gửi `status` sẽ đưa nó về `DRAFT`.
- Model chưa trả lời được: giữ `PROCESSING`, server tự thử lại mỗi 5 phút. FE tiếp tục poll `GET /posts/:id` như với video.

Video: chữ của bài, 4 khung hình lấy từ Cloudinary và transcript lời thoại được chấm cùng lúc trước khi xuất bản. Bài ở `PROCESSING` cho đến khi có transcript (thường vài giây đến vài chục giây sau khi video xử lý xong). Video không có lời thoại hoặc ghi lời lỗi thì chỉ chấm chữ và khung hình.
Blog: tiêu đề, nội dung, ảnh bìa và tối đa 5 ảnh trong nội dung Markdown.

## Thông báo cho tác giả

Mỗi lần trạng thái bài thay đổi do kiểm duyệt, tác giả nhận một thông báo từ hệ thống (`GET /notifications`, SSE `/notifications/sse`):

| `type` | Khi nào | Trường đi kèm |
| --- | --- | --- |
| `POST_REJECTED` | Bài bị chặn tự động, hoặc admin từ chối bài đang chờ duyệt | `reason` (nhóm vi phạm), `note` (ghi chú của admin, có thể null) |
| `POST_PENDING_REVIEW` | Bài bị giữ chờ admin | `reason` (nhóm nghi ngờ) |
| `POST_APPROVED` | Admin cho phép đăng (kể cả bài đã bị chặn) | `note` |

Với các loại này `actor` là `null` (từ Vedora, không phải thành viên). `postType` (`POST` hoặc `BLOG`) cho biết nên mở bài hay mở trình soạn blog. Admin xác nhận lại một bài đã bị chặn thì không gửi thông báo mới.

## Hiển thị cho tác giả

Bài đang `PROCESSING` hoặc `PENDING_REVIEW` chỉ tác giả thấy, FE nên hiện "đang được kiểm duyệt" / "đang chờ quản trị viên xem xét". `PROCESSING` tự chuyển trạng thái, nên poll `GET /posts/:id`. Bài `REJECTED` hiện lý do từ `moderationVerdict`.

## Admin

- Hàng chờ: `GET /admin/posts?status=PENDING_REVIEW` (hoặc `REJECTED`). Mỗi bài có `moderation`: `verdict`, `violationScore`, `scores` (xác suất từng nhóm), `checkedAt`, `reviewedById`, `reviewedAt`, `reviewNote`.
- Quyết định: `POST /admin/posts/:id/moderation` với `{ "decision": "APPROVE" | "REJECT", "note"?: string }`. APPROVE xuất bản bài (kể cả bài đã bị `REJECTED`), REJECT chặn bài. Bài ở trạng thái khác trả 409 `POST_NOT_REVIEWABLE`.

## FE cần xử lý

`PostStatus` có thêm `PENDING_REVIEW` và `REJECTED`; schema zod phải chấp nhận nó và `moderationVerdict` (nullable string).
