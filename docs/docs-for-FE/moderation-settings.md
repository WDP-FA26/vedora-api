# Cài đặt chính sách kiểm duyệt (admin)

Chính sách mà model kiểm duyệt (Claude Haiku) dùng (prompt chung và các nhóm vi phạm cùng định nghĩa) lưu trong MongoDB và admin sửa được. Chưa ai lưu thì dùng bản mặc định trong code. Không còn ngưỡng: model trả mức rủi ro 0-3, và cách xử lý từng mức cố định (xem [content-moderation.md](content-moderation.md)). Thay đổi áp dụng cho nội dung đăng sau đó, trong khoảng 15 giây (cache). Nội dung đã kiểm duyệt giữ nguyên kết quả.

Tất cả endpoint cần quyền ADMIN.

| Method | Đường dẫn | Việc |
| --- | --- | --- |
| GET | `/admin/moderation/settings` | Chính sách hiện tại |
| PUT | `/admin/moderation/settings` | Thay toàn bộ chính sách |
| POST | `/admin/moderation/settings/reset` | Quay về bản mặc định |
| POST | `/admin/moderation/settings/test` | Thử một đoạn văn với chính sách đã lưu hoặc bản nháp, không lưu gì |

## Dữ liệu

```json
{
  "instructions": "Prompt chung cho model",
  "allowDescription": "Tiêu chí của nhóm `allow`",
  "choices": [
    { "key": "violence", "label": "Bạo lực", "reasonText": "bạo lực hoặc đe dọa", "description": "Tiêu chí cho model" }
  ],
  "version": 1,
  "updatedAt": "...",
  "updatedById": "...",
  "isDefault": false
}
```

- Mỗi `description` là định nghĩa của nhóm, đưa nguyên văn vào prompt; định nghĩa càng rõ thì model chấm càng đúng. Thứ tự `choices` chỉ là thứ tự hiển thị.
- `allow` có sẵn, không nằm trong `choices`; chỉ sửa được `allowDescription`.
- `key` gồm 2-32 ký tự (chữ thường, số, `_`, bắt đầu bằng chữ), không trùng, không phải `allow`. Bài đã kiểm duyệt lưu `key`, nên đừng dùng lại một `key` cho ý nghĩa khác. Xoá hoặc đổi tên nhóm không làm mất kết quả đã lưu: chỉ nhãn hiển thị cho tác giả là `null`.
- `manipulation` (chèo lái AI) có sẵn: luôn nằm trong `choices`, gửi thiếu thì API tự thêm lại bản mặc định. Sửa được `label`, `reasonText`, `description`; FE nên ẩn nút xoá của nhóm này.
- `reasonText` là cụm từ hiển thị cho tác giả sau "vi phạm tiêu chuẩn cộng đồng: ". API trả nó ở `moderationReason` và `moderationFindings[].reasonText` của bài (`REJECTED`), `details.reasonText` của lỗi bình luận `CONTENT_REJECTED`, và `reasonText` của thông báo.
- Giới hạn: 1-16 nhóm, `instructions` 20-3000 ký tự, mô tả 10-800, `label` 1-40, `reasonText` 3-120.

## Lưu

`PUT` nhận đúng các trường sửa được (`instructions`, `allowDescription`, `choices`) cộng `version` đã tải về. Không gửi `updatedAt`, `updatedById`, `isDefault`, hay các trường ngưỡng cũ (`rejectThreshold`, `reviewThreshold`, `manipulationThreshold`): API từ chối trường lạ.

- `400 VALIDATION_FAILED`: `details.messages` liệt kê mọi lỗi. Chuỗi được cắt khoảng trắng đầu/cuối trước khi kiểm tra; `key` không được là `allow` và không được trùng nhau.
- `409 CONFLICT`: có admin khác đã lưu bản mới hơn; tải lại rồi sửa.
- Sau khi reset, `GET` trả bản mặc định với `version: 0`; lưu bằng `version: 0`. Số version thật vẫn đếm tiếp (không quay về 1), nên trang sửa nào còn giữ `version` tải từ trước khi reset sẽ nhận `409`.

`test` nhận `{ "text": "...", "settings": { ...bản nháp, không có version } }`; bỏ `settings` để thử bản đã lưu. Trả `decision` (`publish`, `review`, `reject`), `category` (hoặc `null`), `riskLevel` (0-3, `null` khi model từ chối đọc) và `summary` (lý do, tiếng Việt). Endpoint này gọi model nên chậm và tốn một chút phí.
