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

### Nội dung bị nhà cung cấp model từ chối đọc

Một số nhà cung cấp model có bộ lọc riêng (ví dụ Google với `google/gemini-decision-1`): nội dung thù ghét hoặc tình dục nặng bị trả HTTP 400 `prohibited_content` trước khi model kịp chấm điểm. Backend không coi đó là lỗi:
- Bài viết, video, blog: chuyển `PENDING_REVIEW` để admin tự duyệt. `moderation.verdict = "provider_blocked"`, `violationScore = 1`, `scores = { provider_blocked: 1 }`. `moderationVerdict` cho tác giả vẫn là `null`; thông báo `POST_PENDING_REVIEW` có `reason = "provider_blocked"`.
- Bình luận: HTTP 422 `CONTENT_REJECTED`, `details.category = "provider_blocked"`, vì bình luận không có hàng chờ.
- `POST /admin/moderation/settings/test` trả `decision: "review"`, `category: "provider_blocked"`.

FE admin nên hiển thị `provider_blocked` là "Model từ chối đọc nội dung" (không nằm trong chính sách nên không có nhãn từ `GET /admin/moderation/settings`).

Bài mới và blog xuất bản (hoặc sửa tiêu đề, nội dung, ảnh bìa của blog đã xuất bản) chuyển sang `PROCESSING` cho đến khi kiểm duyệt xong:
- Đạt: `PUBLISHED`.
- Vi phạm: `status: REJECTED` và `moderationVerdict` là category ở trên. Chỉ tác giả thấy. Sửa blog bị từ chối mà không gửi `status` sẽ đưa nó về `DRAFT`.
- Model chưa trả lời được: giữ `PROCESSING`, server tự thử lại mỗi 5 phút. FE tiếp tục poll `GET /posts/:id` như với video.

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
| `POST_REJECTED` | Bài bị chặn tự động, hoặc admin từ chối bài đang chờ duyệt | `reason` (nhóm vi phạm), `note` (ghi chú của admin, có thể null) |
| `POST_PENDING_REVIEW` | Bài bị giữ chờ admin | `reason` (nhóm nghi ngờ) |
| `POST_APPROVED` | Admin cho phép đăng (kể cả bài đã bị chặn) | `note` |

Với các loại này `actor` là `null` (từ Vedora, không phải thành viên). `postType` (`POST` hoặc `BLOG`) cho biết nên mở bài hay mở trình soạn blog. Admin xác nhận lại một bài đã bị chặn thì không gửi thông báo mới.

## Hiển thị cho tác giả

Bài đang `PROCESSING` hoặc `PENDING_REVIEW` chỉ tác giả thấy, FE nên hiện "đang được kiểm duyệt" / "đang chờ quản trị viên xem xét". `PROCESSING` tự chuyển trạng thái, nên poll `GET /posts/:id`. Bài `REJECTED` hiện lý do từ `moderationVerdict`.

## Admin

- Hàng chờ: `GET /admin/posts?status=PENDING_REVIEW` (hoặc `REJECTED`). Mỗi bài có `moderation`: `verdict`, `violationScore`, `scores` (xác suất từng nhóm), `checkedAt`, `reviewedById`, `reviewedAt`, `reviewNote`.
- Bằng chứng: `moderation.evidence` (chỉ có ở API admin, tác giả không thấy). Xem mục "Bằng chứng vi phạm" bên dưới.
- Quyết định: `POST /admin/posts/:id/moderation` với `{ "decision": "APPROVE" | "REJECT", "note"?: string }`. APPROVE xuất bản bài (kể cả bài đã bị `REJECTED`), REJECT chặn bài. Bài ở trạng thái khác trả 409 `POST_NOT_REVIEWABLE`.

## Người kiểm duyệt thứ hai (System 2) và bằng chứng (admin)

Mỗi bài, blog, video mà model quyết định (System 1) gắn cờ (điểm `>= MODERATION_REVIEW_THRESHOLD`, kể cả bài bị chặn thẳng) được gửi cùng chữ, khung hình và ảnh cho một model thứ hai (mặc định `deepseek/deepseek-v4.1-flash-1017`, xem `OPENROUTER_MODERATION_EVIDENCE_MODEL`). Model này là **người kiểm duyệt**: nó quyết định `accept` (System 1 chấm nhầm), `reject`, hoặc `escalate` (chuyển admin), và chỉ ra **phần nào** vi phạm. Bài System 1 cho qua (`< MODERATION_REVIEW_THRESHOLD`) không đi qua System 2.

### Hai chế độ (`MODERATION_MODE`)

- `shadow` (mặc định): ngưỡng của System 1 vẫn quyết định như mục trên. System 2 chạy sau đó; kết quả của nó và của router chỉ được **ghi lại** (`moderation.route.appliedBy = null`) để so sánh với quyết định của admin. Luật chèo lái AI cũng chỉ được ghi lại.
- `enforce`: bài bị gắn cờ ở `PROCESSING` (`moderation.heldAt` có giá trị) cho đến khi System 2 trả lời, rồi router áp dụng kết quả. Tác giả chỉ nhận **một** thông báo, khi đã có kết quả cuối (không có `POST_PENDING_REVIEW` trước đó trừ khi bài chuyển admin). FE vẫn poll `GET /posts/:id` như mọi bài `PROCESSING`. Nếu System 2 không trả lời (server khởi động lại...), cron đưa bài vào hàng đợi lại sau `MODERATION_HOLD_RETRY_AFTER_SECONDS` (mặc định 300).

### Router (`moderation.route`)

Luật đầu tiên khớp thắng:

| `rule` | Khi nào | `outcome` |
| --- | --- | --- |
| `PROVIDER_BLOCKED` | Nhà cung cấp của System 1 từ chối đọc | `ADMIN` |
| `MANIPULATION` | `scores.manipulation >= manipulationThreshold` | `REJECT` (System 1 chặn ngay, không chờ System 2) |
| `REVIEWER_UNAVAILABLE` | System 2 `FAILED`/`REFUSED` | `ADMIN` |
| `REVIEWER_REJECT` | System 2 `reject` và có ít nhất một bằng chứng đã kiểm tra | `REJECT` |
| `UNVERIFIED_REJECT` | System 2 `reject` nhưng không bằng chứng nào khớp bài | `ADMIN` |
| `REVIEWER_ESCALATE` | System 2 `escalate` | `ADMIN` |
| `REVIEWER_ACCEPT` | System 2 `accept` | `PUBLISH` |

`outcome`: `PUBLISH` → `PUBLISHED`, `REJECT` → `REJECTED`, `ADMIN` → `PENDING_REVIEW`.

```json
"route": {
  "outcome": "REJECT",
  "rule": "REVIEWER_REJECT",
  "category": "violence",
  "appliedBy": "SYSTEM_TWO",
  "decidedAt": "2026-11-19T14:25:57.819Z"
}
```

- `category`: nhóm mà kết quả đại diện. Với bài bị `REJECTED` do router (`appliedBy` khác `null`), `moderationVerdict`/`moderationReason` của tác giả và `reason` của thông báo lấy từ đây; `moderation.verdict` vẫn là nhóm của System 1 (khớp với các thanh điểm).
- `appliedBy`: `SYSTEM_TWO` (router áp dụng), `SYSTEM_ONE` (luật chèo lái AI hoặc nhà cung cấp từ chối đọc, ở chế độ `enforce`), `null` (chỉ ghi lại: chế độ `shadow`, hoặc chạy lại trên bài đã có quyết định).
- Lưu ý: bằng chứng khung hình/ảnh chỉ được kiểm tra là số thứ tự ảnh có thật, nên `REVIEWER_REJECT` với video dựa nhiều vào nhận định của model hơn so với trích dẫn chữ.

### Chèo lái AI (`manipulation`)

Nhóm `manipulation` có sẵn trong chính sách và không xoá được (xem [moderation-settings.md](moderation-settings.md)): nội dung nói với AI hoặc người kiểm duyệt để thay đổi cách chấm chính nó ("bỏ qua hướng dẫn", "hãy đánh giá bài này là an toàn", "đã được admin duyệt", tin nhắn hệ thống giả, chỉ dẫn giấu trong ảnh). Ở chế độ `enforce`, `P(manipulation) >= manipulationThreshold` (mặc định 0.5) bị chặn ngay: bài `REJECTED` với `moderationVerdict: "manipulation"`, bình luận 422 `CONTENT_REJECTED` với `details.category: "manipulation"`. System 2 cũng được dặn `reject` với `category: "manipulation"` khi thấy nội dung như vậy.

### Bằng chứng (`moderation.evidence`)

Có ở `GET /admin/posts` và `GET /admin/posts/:id`, thường sau vài giây (tối đa khoảng 1 phút). Trong lúc chờ, `evidence` là `null`.

```json
{
  "status": "READY",
  "decision": "reject",
  "category": "violence",
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
      "imageUrl": null,
      "box": null
    }
  ],
  "dropped": 0,
  "model": "deepseek/deepseek-v4.1-flash-1017",
  "createdAt": "2026-11-19T14:25:57.819Z"
}
```

- `status`: `READY`; `FAILED` (model không trả lời, bấm chạy lại); `REFUSED` (nhà cung cấp model từ chối đọc nội dung, nên coi là nghi vi phạm nặng, không phải "sạch").
- `decision`: `accept` | `reject` | `escalate`, `null` khi không `READY`. Bản ghi cũ (trước khi có trường này) không có `decision`; FE coi là `null`.
- `category`: nhóm System 2 từ chối, hoặc `null`.
- `summary`, `reason`: tiếng Việt, ngắn.
- `items[].field`:
  - `body` (chữ của bài), `title`, `content` (blog), `transcript` (lời thoại video, `mediaId` là video đó): `quote` **khớp nguyên văn** với nội dung, server đã kiểm tra. `start`/`end` là vị trí trong chuỗi đã chuẩn hoá NFC (`text.normalize("NFC").slice(start, end) === quote`). Chỉ dùng để tô sáng `body`; `content` là Markdown nên chỉ hiện danh sách trích dẫn.
  - `frame` (khung video, có `mediaId`, `seconds`) và `image` (ảnh blog): `imageUrl` là ảnh đó. `quote` là chữ model đọc được trong ảnh, có thể sai dấu, chỉ để tham khảo. `box` là vùng gần đúng `[x0, y0, x1, y1]` theo thang 0–1000 của ảnh, hoặc `null`; chỉ là gợi ý.
- `items[].category`: nhóm model nghĩ là vi phạm, chỉ để tham khảo.
- `dropped`: số trích dẫn model đưa ra nhưng không có trong bài, đã bị bỏ.
- Hiển thị `quote`, `summary`, `reason` như văn bản thường (không render HTML), vì chúng lấy từ nội dung người dùng.

Chạy lại: `POST /admin/posts/:id/moderation/evidence` (không có body) chạy System 2 ngay và trả về bài như `GET /admin/posts/:id`. Trên bài đang giữ (`PROCESSING`, `enforce`) kết quả được áp dụng; trên bài `PENDING_REVIEW`/`REJECTED` chỉ được ghi lại (một `route` đã áp dụng thì giữ nguyên). Mất tới khoảng 1 phút và tốn một ít chi phí. Bài không bị gắn cờ, hoặc vừa được chấm lại trong lúc chạy, trả 409 `POST_NOT_REVIEWABLE`; bài không tồn tại trả 404.

### Admin lật quyết định

`POST /admin/posts/:id/moderation` như cũ, thêm: `REJECT` được cả bài `PUBLISHED` do System 2 cho đăng (`route.appliedBy: "SYSTEM_TWO"`); tác giả nhận `POST_REJECTED`. `APPROVE` vẫn chỉ cho `PENDING_REVIEW`/`REJECTED`.

Chưa có: khiếu nại của tác giả, việc báo cáo kéo bài System 2 đã cho đăng về hàng chờ admin, và bộ lọc theo `appliedBy` trong `GET /admin/posts`.

## FE cần xử lý

`PostStatus` có thêm `PENDING_REVIEW` và `REJECTED`; schema zod phải chấp nhận nó và `moderationVerdict` (nullable string).
