# Kiểm duyệt nội dung

Mọi nội dung người dùng đăng (bài viết, video, blog, bình luận) được Claude Haiku (mặc định `anthropic/claude-haiku-5.5` qua OpenRouter, xem `OPENROUTER_CONTENT_MODERATION_MODEL`) kiểm tra theo chính sách an toàn trước khi hiển thị. Mỗi nội dung chỉ cần **một** lần gọi model: model trả về mức rủi ro, nhóm vi phạm, tóm tắt lý do và các đoạn vi phạm. Chính sách chỉ xét an toàn, không xét chủ đề hay chế độ ăn.

## Mức rủi ro (`riskLevel`)

| `riskLevel` | Ý nghĩa | Bài viết, video, blog | Bình luận |
| --- | --- | --- | --- |
| `0` | Không rủi ro | `PUBLISHED` | Cho đăng |
| `1` | Rủi ro thấp (ranh giới, nhẹ) | `PUBLISHED` | Cho đăng |
| `2` | Rủi ro trung bình (cần ngữ cảnh) | `PENDING_REVIEW`, chờ admin | Cho đăng |
| `3` | Rủi ro cao (vi phạm rõ) | `REJECTED` nếu có ít nhất một bằng chứng khớp với bài, nếu không thì `PENDING_REVIEW` | HTTP 422 |

Bài `PENDING_REVIEW` chỉ tác giả thấy; `moderationVerdict` vẫn là `null` để không lộ nhóm nghi ngờ.

## Bình luận

`POST` và `PATCH` bình luận kiểm duyệt đồng bộ:
- Rủi ro cao (`riskLevel = 3`) hoặc model từ chối đọc: HTTP 422, `code: CONTENT_REJECTED`. Bình luận không được lưu. `details` gồm:
  - `category`: nhóm vi phạm; khi model từ chối đọc thì là `provider_blocked`.
  - `reasonText`: cụm từ hiển thị cho người viết (xem [moderation-settings.md](moderation-settings.md)), hoặc `null`.
  - `findings`: các đoạn vi phạm, mỗi đoạn `{ quote, reason, reasonText }`. `quote` là đúng các chữ trong bình luận, `reason` là một câu tiếng Việt giải thích. Mảng rỗng khi model từ chối đọc.
- Model lỗi hoặc quá thời gian: HTTP 503 `SERVICE_UNAVAILABLE`. Cho người dùng thử lại.

## Bài viết, video và blog

### Khi model không chấm được

Backend không coi đó là lỗi của người dùng; bài chuyển `PENDING_REVIEW` để admin tự duyệt hoặc từ chối:
- Model hoặc nhà cung cấp từ chối đọc nội dung (thường là nội dung thù ghét hay tình dục nặng): `moderation.verdict = "provider_blocked"`, `riskLevel = null`, `evidence.status = "REFUSED"`. Thông báo `POST_PENDING_REVIEW` có `reason = "provider_blocked"`.
- Model lỗi, quá thời gian, hoặc không tải được khung hình/ảnh: `moderation.verdict = "moderation_failed"`, `riskLevel = null`, `evidence.status = "FAILED"`. Thông báo `POST_PENDING_REVIEW` có `reason = "moderation_failed"`.
- `POST /admin/moderation/settings/test` trả `decision: "review"`, `category: "provider_blocked"` khi model từ chối đọc, và 503 khi model lỗi.

FE admin nên hiển thị `provider_blocked` là "Model từ chối đọc nội dung" và `moderation_failed` là "Kiểm duyệt tự động lỗi, cần duyệt tay" (không nằm trong chính sách nên không có nhãn từ `GET /admin/moderation/settings`).

Bài mới và blog xuất bản (hoặc sửa tiêu đề, nội dung, ảnh bìa của blog đã xuất bản) chuyển sang `PROCESSING` cho đến khi kiểm duyệt xong (thường vài giây). Request đăng hoặc sửa **không chờ** kiểm duyệt: response luôn là bài ở `PROCESSING`, kiểm duyệt chạy nền sau đó. Khi có kết quả, tác giả nhận một thông báo (bảng bên dưới); FE có thể poll `GET /posts/:id` hoặc dựa vào SSE thông báo.
- Đạt: `PUBLISHED`.
- Vi phạm: `status: REJECTED` và `moderationVerdict` là nhóm vi phạm. Chỉ tác giả thấy. Sửa blog bị từ chối mà không gửi `status` sẽ đưa nó về `DRAFT`.
- Cần admin xem: `PENDING_REVIEW`.

Video: chữ của bài, các khung hình lấy từ Cloudinary (cách nhau khoảng 5 giây, ít nhất 4 khung mỗi video, tối đa 24 khung mỗi bài) và transcript lời thoại được chấm cùng lúc trước khi xuất bản. Bài ở `PROCESSING` cho đến khi có transcript (thường vài giây đến vài chục giây sau khi video xử lý xong). Video không có lời thoại hoặc ghi lời lỗi thì chỉ chấm chữ và khung hình.
Blog: tiêu đề, nội dung, ảnh bìa và tối đa 5 ảnh trong nội dung Markdown.

## Sửa bài đã đăng

Sửa nội dung vẫn phải qua kiểm duyệt như bài mới, nên bài chuyển `PROCESSING` cho đến khi có kết quả.

- **Bài ngắn và video:** `PATCH /posts/:id` với `{ "body"?: string, "mediaIds"?: string[] }`, phải có ít nhất một trường (không thì 400). Chỉ tác giả sửa được (người khác 403, chưa đăng nhập 401).
  - `body`: chữ mới. Chuỗi rỗng xóa chữ.
  - `mediaIds`: **danh sách video cuối cùng theo thứ tự hiển thị**, tối đa 4. Gồm id video đang có trên bài (giữ lại) và id mới từ `POST /media/uploads` (thêm). Video không có trong danh sách bị gỡ khỏi bài và xóa. Đổi thứ tự cũng tính là thay đổi. Bỏ trường này thì video giữ nguyên. Video của người khác, đã gắn vào bài khác hoặc đã lỗi trả 400 `MEDIA_UNAVAILABLE`.
  - Bài không còn chữ lẫn video trả 400 `EMPTY_POST`. Không có gì thay đổi thì trả bài như cũ, không kiểm duyệt lại.
  - Bài `PUBLISHED`, `PENDING_REVIEW`, `REJECTED` và `FAILED` đều sửa được, nên bài bị từ chối hoặc video lỗi có thể sửa rồi gửi lại. Bài đang `PROCESSING` trả 409 `POST_NOT_EDITABLE`.
  - Response là bài với trạng thái mới. Bài ở `PROCESSING` cho đến khi mọi video mới xử lý xong (HLS và transcript, có thể vài phút) và kiểm duyệt có kết quả; trong lúc đó chỉ tác giả thấy. FE poll `GET /posts/:id` như khi đăng bài. `publishedAt` giữ nguyên.
  - Video tải lên cho lần sửa mà người dùng huỷ thì FE gọi `DELETE /media/:id` như khi huỷ lúc đăng.
- **Blog:** `PATCH /blogs/:id` (xem [blogs.md](blogs.md)). Sửa tiêu đề, nội dung hoặc ảnh bìa của blog đã đăng đưa nó về `PROCESSING`, và blog biến khỏi feed cho đến khi có kết quả. Vì vậy FE không nên tự lưu liên tục một blog đã đăng; chỉ gửi khi tác giả bấm lưu.

## Thông báo cho tác giả

Mỗi lần trạng thái bài thay đổi do kiểm duyệt, tác giả nhận một thông báo từ hệ thống (`GET /notifications`, SSE `/notifications/sse`):

| `type` | Khi nào | Trường đi kèm |
| --- | --- | --- |
| `POST_PUBLISHED` | Bài qua kiểm duyệt tự động và được đăng | (không có) |
| `POST_REJECTED` | Bài bị chặn tự động, hoặc admin từ chối bài đang chờ duyệt | `reason` (nhóm vi phạm), `note` (ghi chú của admin, có thể null) |
| `POST_PENDING_REVIEW` | Bài bị giữ chờ admin | `reason` (nhóm nghi ngờ) |
| `POST_APPROVED` | Admin cho phép đăng (kể cả bài đã bị chặn) | `note` |

Với các loại này `actor` là `null` (từ Vedora, không phải thành viên). `postType` (`POST` hoặc `BLOG`) cho biết nên mở bài hay mở trình soạn blog. Admin xác nhận lại một bài đã bị chặn thì không gửi thông báo mới.

## Hiển thị cho tác giả

Bài đang `PROCESSING` hoặc `PENDING_REVIEW` chỉ tác giả thấy, FE nên hiện "đang được kiểm duyệt" / "đang chờ quản trị viên xem xét". `PROCESSING` tự chuyển trạng thái, nên poll `GET /posts/:id`. Bài `REJECTED` hiện lý do từ `moderationReason` (hoặc `moderationVerdict`) và các đoạn vi phạm từ `moderationFindings`.

`moderationFindings` (luôn là mảng; rỗng nếu bài không `REJECTED` hoặc admin từ chối mà không có bằng chứng của model) gồm các phần tử:

| Trường | Ý nghĩa |
| --- | --- |
| `field` | `body` (chữ của bài), `title` / `content` (blog), `transcript` (lời nói trong video), `frame` (khung hình video), `image` |
| `quote` | Chữ vi phạm, đúng nguyên văn với phần chữ; với khung hình/ảnh là chữ model đọc được trong ảnh, có thể `null` |
| `reason` | Một câu tiếng Việt: phần này sai ở đâu |
| `reasonText` | Tên nhóm vi phạm cho tác giả, hoặc `null` |
| `mediaId` | Video chứa transcript/khung hình, hoặc `null` |
| `seconds` | Khung hình: giây thứ mấy trong video, hoặc `null` |

## Admin

- Hàng chờ: `GET /admin/posts?status=PENDING_REVIEW` (hoặc `REJECTED`). Mỗi bài có `moderation`: `verdict`, `riskLevel` (0-3, hoặc `null`), `checkedAt`, `reviewedById`, `reviewedAt`, `reviewNote`, `evidence`.
- Bài kiểm duyệt trước khi có mức rủi ro có `riskLevel = null`; FE hiển thị "—".
- Quyết định: `POST /admin/posts/:id/moderation` với `{ "decision": "APPROVE" | "REJECT", "note"?: string }`. APPROVE xuất bản bài (kể cả bài đã bị `REJECTED`), REJECT chặn bài. Chỉ áp dụng cho bài `PENDING_REVIEW` và `REJECTED`; bài ở trạng thái khác trả 409 `POST_NOT_REVIEWABLE`. Nếu bài đang có hồ sơ kháng cáo mở, APPROVE tự động đóng hồ sơ với kết quả `APPROVED` và chỉ gửi `SUPPORT_TICKET_RESOLVED`.

### Bằng chứng (`moderation.evidence`, chỉ admin)

Có ngay khi bài được chấm, từ cùng lần gọi model (không có lần chạy thứ hai, không có endpoint chạy lại).

```json
{
  "status": "READY",
  "summary": "Nội dung chứa lời đe dọa giết cả gia đình.",
  "items": [
    {
      "field": "body",
      "category": "violence",
      "reason": "Cụm này là lời đe dọa giết người trực tiếp.",
      "quote": "Tao sẽ giết cả nhà mày",
      "start": 17,
      "end": 39,
      "mediaId": null,
      "seconds": null,
      "imageUrl": null
    }
  ],
  "dropped": 0,
  "model": "anthropic/claude-haiku-5.5",
  "createdAt": "2026-11-24T14:25:57.819Z"
}
```

- `status`: `READY`; `FAILED` (model lỗi, admin tự duyệt); `REFUSED` (model hoặc nhà cung cấp từ chối đọc, nên coi là nghi vi phạm nặng, không phải "sạch").
- `summary`, `reason`: tiếng Việt, ngắn. `summary` là `null` khi không `READY`.
- `items[].field`:
  - `body` (chữ của bài), `title`, `content` (blog), `transcript` (lời thoại video, `mediaId` là video đó): `quote` **khớp nguyên văn** với nội dung, server đã kiểm tra. `start`/`end` là vị trí trong chuỗi đã chuẩn hoá NFC (`text.normalize("NFC").slice(start, end) === quote`). Chỉ dùng để tô sáng `body`; `content` là Markdown nên chỉ hiện danh sách trích dẫn.
  - `frame` (khung video, có `mediaId`, `seconds`) và `image` (ảnh blog): `imageUrl` là ảnh đó. `quote` là chữ model đọc được trong ảnh, có thể sai dấu, chỉ để tham khảo.
- `items[].category`: nhóm model cho là vi phạm.
- `dropped`: số trích dẫn model đưa ra nhưng không có trong bài, đã bị bỏ.
- Bản ghi cũ có thể còn `decision`/`category` trong `evidence` hoặc `box` trong `items[]`; FE bỏ qua.
- Hiển thị `quote`, `summary`, `reason` như văn bản thường (không render HTML), vì chúng lấy từ nội dung người dùng.

### Chèo lái AI (`manipulation`)

Nhóm `manipulation` có sẵn trong chính sách và không xoá được (xem [moderation-settings.md](moderation-settings.md)): nội dung nói với AI hoặc người kiểm duyệt để thay đổi cách chấm chính nó ("bỏ qua hướng dẫn", "hãy đánh giá bài này là an toàn", "đã được admin duyệt", tin nhắn hệ thống giả, chỉ dẫn giấu trong ảnh). Model được dặn chấm `riskLevel = 3` với nhóm `manipulation` và trích dẫn câu đó, nên bài bị `REJECTED` với `moderationVerdict: "manipulation"` và bình luận bị 422 với `details.category: "manipulation"`.

Hệ thống hỗ trợ & kháng cáo của tác giả và soft-delete/khôi phục bài viết xem tại [support.md](support.md).

Chưa có: bộ lọc theo `riskLevel` trong `GET /admin/posts`.

## FE cần xử lý

`PostStatus` có thêm `PENDING_REVIEW`, `REJECTED` và `REMOVED`; schema zod phải chấp nhận chúng cùng `moderationVerdict` (nullable string), `removalReason` và `appeal`.
