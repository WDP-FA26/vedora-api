# Kiểm duyệt nội dung

Mọi nội dung người dùng đăng (bài viết, video, blog, bình luận) được model quyết định (mặc định `google/gemini-decision-1` qua OpenRouter, xem `OPENROUTER_CONTENT_MODERATION_MODEL`) kiểm tra theo chính sách an toàn trước khi hiển thị. Chính sách chỉ xét an toàn, không xét chủ đề hay chế độ ăn.

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

### Nội dung bị nhà cung cấp model từ chối đọc

Model mặc định (`google/gemini-decision-1`) có bộ lọc riêng của Google: nội dung thù ghét hoặc tình dục nặng bị trả HTTP 400 `prohibited_content` trước khi model kịp chấm điểm. Backend không coi đó là lỗi:
- Bài viết, video, blog: chuyển `PENDING_REVIEW` để admin tự duyệt. `moderation.verdict = "provider_blocked"`, `violationScore = 1`, `scores = { provider_blocked: 1 }`. `moderationVerdict` cho tác giả vẫn là `null`; thông báo `POST_PENDING_REVIEW` có `reason = "provider_blocked"`.
- Bình luận: HTTP 422 `CONTENT_REJECTED`, `details.category = "provider_blocked"`, vì bình luận không có hàng chờ.
- `POST /admin/moderation/settings/test` trả `decision: "review"`, `category: "provider_blocked"`.

FE admin nên hiển thị `provider_blocked` là "Model từ chối đọc nội dung" (không nằm trong chính sách nên không có nhãn từ `GET /admin/moderation/settings`).

Bài mới và blog xuất bản (hoặc sửa tiêu đề, nội dung, ảnh bìa của blog đã xuất bản) chuyển sang `PROCESSING` cho đến khi kiểm duyệt xong:
- Đạt: `PUBLISHED`.
- Vi phạm: `status: REJECTED` và `moderationVerdict` là category ở trên. Chỉ tác giả thấy. Sửa blog bị từ chối mà không gửi `status` sẽ đưa nó về `DRAFT`.
- Model chưa trả lời được: giữ `PROCESSING`, server tự thử lại mỗi 5 phút. FE tiếp tục poll `GET /posts/:id` như với video.

Video: chữ của bài, 4 khung hình lấy từ Cloudinary và transcript lời thoại được chấm cùng lúc trước khi xuất bản. Bài ở `PROCESSING` cho đến khi có transcript (thường vài giây đến vài chục giây sau khi video xử lý xong). Video không có lời thoại hoặc ghi lời lỗi thì chỉ chấm chữ và khung hình.
Blog: tiêu đề, nội dung, ảnh bìa và tối đa 5 ảnh trong nội dung Markdown.

## Sửa bài đã đăng

Sửa nội dung vẫn phải qua kiểm duyệt như bài mới, nên bài chuyển `PROCESSING` cho đến khi có kết quả.

- **Bài ngắn và video:** `PATCH /posts/:id` với `{ "body": "..." }`. Chỉ tác giả sửa được (người khác 403, chưa đăng nhập 401) và chỉ sửa chữ; video đính kèm giữ nguyên. Chữ không đổi thì trả bài như cũ, không kiểm duyệt lại. `body` rỗng chỉ hợp lệ khi bài có video, nếu không trả 400 `EMPTY_POST`. Bài đang `PROCESSING` hoặc `FAILED` trả 409 `POST_NOT_EDITABLE`. Bài `PUBLISHED`, `PENDING_REVIEW` và `REJECTED` đều sửa được, nên bài bị từ chối có thể sửa rồi gửi lại. Response là bài với trạng thái mới (`PROCESSING`, hoặc đã có kết quả ngay): FE poll `GET /posts/:id` như khi đăng bài. `publishedAt` giữ nguyên.
- **Blog:** `PATCH /blogs/:id` (xem [blogs.md](blogs.md)). Sửa tiêu đề, nội dung hoặc ảnh bìa của blog đã đăng đưa nó về `PROCESSING`, và blog biến khỏi feed cho đến khi có kết quả. Vì vậy FE không nên tự lưu liên tục một blog đã đăng; chỉ gửi khi tác giả bấm lưu.

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
