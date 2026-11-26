# Kho kiến thức: duyệt kết quả OCR

Chỉ admin dùng được mọi endpoint `/knowledge/documents/*` (người khác 403). Upload PDF không còn đưa thẳng vào Qdrant: kết quả OCR phải được admin xem, sửa và duyệt.

## Trạng thái

`WAITING_UPLOAD → PROCESSING (OCR) → AWAITING_REVIEW → INDEXING → READY`, ngoài ra `REJECTED` và `FAILED`.

| `status` | Ý nghĩa | FE làm gì |
| --- | --- | --- |
| `WAITING_UPLOAD`, `PROCESSING`, `INDEXING` | Hệ thống đang chạy | Poll `GET /knowledge/documents` |
| `AWAITING_REVIEW` | OCR xong, chưa vào Qdrant | Mở màn duyệt |
| `READY` | Đã duyệt và index, chatbot dùng được | |
| `REJECTED` | Admin từ chối. File và văn bản vẫn còn | Cho xem, mở lại hoặc xoá |
| `FAILED` | Lỗi trước khi duyệt (`failureReason`) | Xoá và upload lại |

`AWAITING_REVIEW` có thể kèm `failureReason: INDEXING_FAILED`: lần duyệt trước index lỗi (hoặc bị ngắt quá 15 phút). Văn bản đã sửa vẫn còn, bấm duyệt lại được.

Tài liệu `READY` có từ trước tính năng này không có văn bản lưu: `GET :id/pages` trả mảng rỗng.

Mỗi tài liệu có thêm `reviewedById`, `reviewedAt`, `reviewNote` (null khi chưa có quyết định).

## Endpoint

- `POST /knowledge/documents/:id/confirm` → xác nhận file PDF đã được upload lên object storage (kiểm tra bằng `HeadObject`) và bắt đầu OCR (`WAITING_UPLOAD → PROCESSING`). Idempotent nếu tài liệu đã rời `WAITING_UPLOAD`; trả 409 (`CONFLICT`) nếu chưa thấy file trên storage.
- `GET /knowledge/documents/:id/pages` → `[{ page, text, flags, edited }]`, theo thứ tự trang (page bắt đầu từ 1).
  - `flags`: `TEXT_LAYER_ADDED` (OCR sót chữ, hệ thống đã nối thêm text layer của PDF) và `PAGE_COUNT_MISMATCH` (OCR trả số trang khác PDF, chữ có thể nằm sai trang). Nên hiện các trang có cờ lên đầu.
- `PATCH /knowledge/documents/:id/pages/:page` `{ text }` → trang đã sửa (`edited: true`). Chỉ khi `AWAITING_REVIEW`, ngược lại 409 `DOCUMENT_NOT_REVIEWABLE`. Trang không tồn tại 404.
- `GET /knowledge/documents/:id/file-url` → `{ url, expiresAt }` link tải PDF gốc (15 phút). Mở với `#page=N` để đối chiếu. CSP của FE cần cho phép origin lưu trữ trong `frame-src` nếu nhúng bằng iframe.
- `POST /knowledge/documents/:id/approve` `{ note? }` → `AWAITING_REVIEW` sang `INDEXING` (trả tài liệu), rồi tự sang `READY`. Gọi lần hai khi không còn `AWAITING_REVIEW` trả 409.
- `POST /knowledge/documents/:id/reject` `{ note? }` → `REJECTED`. Không xoá gì và không index gì.
- `POST /knowledge/documents/:id/reopen` → `REJECTED` về `AWAITING_REVIEW`.
- `DELETE /knowledge/documents/:id` → xoá file, văn bản các trang và điểm Qdrant, ở mọi trạng thái. Khác với từ chối.

Lỗi 409 dùng `code: DOCUMENT_NOT_REVIEWABLE`.
