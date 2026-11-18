# Hạn thanh toán 30 phút

- Mỗi đơn có `expiresAt = createdAt + 30 phút`. Mở lại trang, đổi thiết bị, reuse đơn hoặc gửi lại cùng Idempotency-Key không gia hạn.
- Đúng lúc `now >= expiresAt`, đơn chưa trả tiền không còn được capture. BE chuyển `PENDING` → `CANCELLED`, `cancellationReason = EXPIRED`, ghi `cancelledAt` và giải phóng `activeIntentKey`. Hủy thủ công dùng `USER`; đơn cũ thiếu reason trả `null`.
- Đơn cũ thiếu `expiresAt` dùng `createdAt + 30 phút`, không tính lại từ lúc deploy. Đơn đã thành công hoặc đã hủy được giữ nguyên.
- Scheduler có sẵn quét tối đa 100 đơn mỗi 10 giây và một lần lúc API khởi động. Vì vậy trạng thái lưu có thể trễ một lượt quét khi không ai truy cập; thời hạn capture vẫn được kiểm tra trực tiếp trong webhook. Không dùng BullMQ hay TTL index xóa dữ liệu tài chính.
- `GET /billing/me`, `GET /payment-intents/:id`, tạo đơn và hủy đơn đều xử lý đơn quá hạn liên quan. Người dùng không phải chờ scheduler mới được mua gói khác.
- Các thao tác hết hạn/capture/hủy dùng chung transaction và khóa payer. Chỉ phát `payment.changed` sau commit; nhiều instance không phát nhiều lần cho cùng lần hủy. Redis gián đoạn không rollback đơn đã hủy; GET vẫn đối soát được.
- Webhook đúng mã, đúng tài khoản và đúng số tiền nhưng được xử lý khi đơn đã hết hạn ghi receipt `PAYMENT_EXPIRED`, trả HTTP 200, không cấp gói và không tự hoàn tiền. Kể cả `transactionDate` trước hạn nhưng webhook đến muộn, đơn đã hết hạn vẫn cần quản trị viên đối soát. Webhook lặp không hồi sinh đơn hoặc trừ thêm hạn mức.
- Chuyển thiếu/sai số tiền tiếp tục dùng `AMOUNT_MISMATCH`, không cộng dồn các lần chuyển. Ngày hết hạn của subscription là trường khác, tính từ `capturedAt` của đơn thành công.

## Contract FE

Payment DTO trên GET/create/cancel và các payment trong billing overview bổ sung:

```json
{
  "createdAt": "2026-11-18T09:00:00.000Z",
  "expiresAt": "2026-11-18T09:30:00.000Z",
  "serverTime": "2026-11-18T09:10:00.000Z",
  "status": "PENDING",
  "cancellationReason": null
}
```

- Trang QR hiển thị `mm:ss` từ `expiresAt - serverTime` rồi trừ thời gian thực đã trôi bằng đồng hồ monotonic của trình duyệt. Không phụ thuộc ngày giờ thiết bị.
- Khi bộ đếm về 0: ẩn QR và thông tin chuyển khoản, thông báo hết hạn, gọi GET làm mới payment và billing, hiện liên kết tạo đơn mới. FE không gọi API hủy thay scheduler và không tự khẳng định đã thanh toán.
- SSE vẫn nhận kết quả capture/hủy; xác nhận SUCCEEDED từ GET có ưu tiên hơn trạng thái đếm ngược cục bộ. Lỗi mạng không làm QR hết hạn hiện trở lại chỉ vì chưa nhận được trạng thái hủy.
- Gửi lại Idempotency-Key của đơn hết hạn trả chính đơn CANCELLED. Một lần mua mới cần key mới như luồng tạo đơn hiện tại.

Triển khai BE trước FE vì schema FE yêu cầu ba trường mới. Không cần thay cấu hình SePay hoặc gói Plus/Pro.
