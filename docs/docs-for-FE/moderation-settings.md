# Cài đặt chính sách kiểm duyệt (admin)

Chính sách mà model kiểm duyệt dùng (các nhóm vi phạm, prompt chung, ngưỡng) lưu trong MongoDB và admin sửa được. Chưa ai lưu thì dùng bản mặc định trong code, với ngưỡng từ biến môi trường. Thay đổi áp dụng cho nội dung đăng sau đó, trong khoảng 15 giây (cache). Nội dung đã kiểm duyệt giữ nguyên kết quả.

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
  "rejectThreshold": 0.85,
  "reviewThreshold": 0.3,
  "version": 1,
  "updatedAt": "...",
  "updatedById": "...",
  "isDefault": false
}
```

- `choices` chỉ là thứ tự hiển thị. Quyết định dựa hoàn toàn vào xác suất model trả cho từng nhóm: điểm vi phạm là `1 - P(allow)`, nhóm hiển thị là nhóm vi phạm có xác suất cao nhất.
- `allow` có sẵn, không nằm trong `choices`; chỉ sửa được `allowDescription`.
- `key` gồm 2-32 ký tự (chữ thường, số, `_`, bắt đầu bằng chữ), không trùng, không phải `allow`. Bài đã kiểm duyệt lưu `key`, nên đừng dùng lại một `key` cho ý nghĩa khác. Xoá hoặc đổi tên nhóm không làm mất kết quả đã lưu: chỉ nhãn hiển thị cho tác giả là `null`.
- `reasonText` là cụm từ hiển thị cho tác giả sau "vi phạm tiêu chuẩn cộng đồng: ". API trả nó ở `moderationReason` của bài (`REJECTED`) và `reasonText` của thông báo.
- Giới hạn: 1-16 nhóm, `instructions` 20-3000 ký tự, mô tả 10-800, `label` 1-40, `reasonText` 3-120, `0 <= reviewThreshold < rejectThreshold <= 1`.

## Lưu

`PUT` nhận đúng các trường sửa được (`instructions`, `allowDescription`, `choices`, `rejectThreshold`, `reviewThreshold`) cộng `version` đã tải về. Không gửi `updatedAt`, `updatedById`, `isDefault` (API từ chối trường lạ).

- `400 VALIDATION_FAILED`: `details.messages` liệt kê mọi lỗi. Chuỗi được cắt khoảng trắng đầu/cuối trước khi kiểm tra; `key` không được là `allow` và không được trùng nhau.
- `409 CONFLICT`: có admin khác đã lưu bản mới hơn; tải lại rồi sửa.

`test` nhận `{ "text": "...", "settings": { ...bản nháp, không có version } }`; bỏ `settings` để thử bản đã lưu. Trả `decision` (`publish`, `review`, `reject`), `category`, `violationScore` và `scores` cho mọi lựa chọn kể cả `allow`. Endpoint này gọi model nên chậm và tốn một chút phí.
