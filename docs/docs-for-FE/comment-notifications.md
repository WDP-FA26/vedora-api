# Thông báo gỡ bình luận và kết quả báo cáo

## Các loại thông báo

Thông báo dùng API danh sách, số chưa đọc, đánh dấu đã đọc và SSE hiện có. Không thêm endpoint hoặc background job.

| `type` | Người nhận | Ý nghĩa |
| --- | --- | --- |
| `COMMENT_REMOVED` | Tác giả bình luận/phản hồi bị admin gỡ | Có thể kèm lý do báo cáo khi gỡ qua hàng đợi admin. |
| `COMMENT_REMOVED_BY_POST_OWNER` | Tác giả bình luận/phản hồi bị chủ bài xóa | Không khẳng định nội dung vi phạm chính sách. |
| `COMMENT_THREAD_REMOVED` | Tác giả các phản hồi bị xóa theo bình luận gốc | Giải thích xóa theo luồng, không quy kết phản hồi vi phạm. |
| `COMMENT_REPORT_RESOLVED` | Người báo cáo nội dung đã bị xóa | Áp dụng khi admin gỡ hoặc xác nhận nội dung đã bị xóa trước đó. |
| `COMMENT_REPORT_DISMISSED` | Người báo cáo khi admin bỏ qua | Giữ nguyên bình luận; chỉ đóng báo cáo được chọn. |

Các thông báo trên có `actor: null` (từ Vedora). `note` là trích đoạn bình luận, được chuẩn hóa khoảng trắng và rút gọn theo `NOTIFICATION_EXCERPT_MAX_LENGTH`, mặc định **80**. `reason` là mã lý do báo cáo nếu phù hợp; không gán lý do vi phạm cho các phản hồi bị xóa theo luồng.

`commentId` luôn `null`: các thông báo này cần tồn tại sau khi bình luận bị xóa và không liên kết tới bình luận không còn. `postId` chỉ được gắn khi bài viết còn công khai tại thời điểm xử lý. Nếu bài viết đã mất/không công khai, FE giữ người dùng tại trang thông báo và vẫn hiển thị trích đoạn.

## Quy tắc gửi

- Áp dụng cả admin gỡ qua hàng đợi và API xóa bình luận hiện có, bao gồm thao tác của chủ bài viết.
- Không gửi cho người đang thao tác hoặc tài khoản hệ thống Vedora AI. Không tạo thông báo cho tài khoản không còn tồn tại.
- Mỗi lần gỡ một luồng: tối đa một thông báo gỡ cho mỗi tác giả. Tác giả bình luận được nhắm tới nhận thông báo trực tiếp; các tác giả còn lại nhận thông báo phản hồi bị xóa theo luồng.
- Một người báo cáo nhiều bình luận trong cùng luồng bị gỡ chỉ nhận một kết quả xử lý cho lần đó. Các người báo cáo khác vẫn nhận kết quả riêng.
- Một người có thể nhận thông báo ở cả vai trò tác giả và người báo cáo nếu họ có hai nội dung liên quan khác nhau.
- Tự xóa bình luận không tạo thông báo cho chính mình; tác giả các trả lời bị xóa theo vẫn được báo.
- Không tiết lộ danh tính hoặc phần chi tiết riêng của người báo cáo trong thông báo gửi tác giả.
- Không gửi bù cho những quyết định đã hoàn tất trước bản cập nhật này. Gửi lại quyết định cũ trả `409` và không sinh thêm thông báo.

## Transaction và realtime

Thông báo được lưu trong cùng MongoDB transaction với xóa nội dung/quyết định báo cáo. Lỗi lưu thông báo làm rollback toàn bộ thao tác. Thông báo gỡ không giữ khóa ngoại `commentId`, nên middleware cascade không xóa mất thông báo mới.

Chỉ phát SSE sau khi transaction đã commit, sử dụng các dòng notification của lần commit thành công. Retry transaction không phát các sự kiện của lần thử bị hủy. Nếu lỗi phát realtime, thao tác đã commit vẫn thành công và các thông báo vẫn được đọc qua API danh sách/số chưa đọc.

## Triển khai

Phát hành FE hiểu đủ năm enum mới **trước** BE phát các thông báo này. FE mới tương thích với thông báo cũ. Không cần API key hoặc biến env bắt buộc mới; muốn đổi độ dài trích đoạn có thể cấu hình `NOTIFICATION_EXCERPT_MAX_LENGTH=80`. Docker Compose đã chuyển tiếp biến này. Mongoose tự cập nhật enum schema khi API khởi động; không có migration Prisma.

## Kiểm thử

```sh
npx vitest run --config vitest.config.e2e.mts test/e2e/comment-notifications.e2e-spec.ts
npx vitest run test/unit/notifications
```

HTTP test dùng MongoDB replica set thật, bao phủ tác giả/người báo cáo, cascade, gom theo người nhận, riêng tư, self/system/missing users, nội dung đã mất, retry đồng thời, lỗi lưu/rollback, retry transaction, lỗi realtime và số chưa đọc/đánh dấu đã đọc. Kiểm thử transaction của NotificationsService xác nhận không phát trước commit và rollback cả thông báo đã được insert.

Kết quả ngày 24/11/2026: 21 HTTP test mới và 109 HTTP test hồi quy pass; 100 unit test liên quan pass; build/lint BE và image production Docker pass. Smoke test với API trong container và MongoDB thật xác minh cả HTTP SSE nhận thông báo, dữ liệu thông báo riêng tư được lưu sau cascade, gom kết quả báo cáo, số chưa đọc và đánh dấu đã đọc. Dùng database fixture riêng và provider credentials giả. Đã đồng bộ main `d335bd4` trước kiểm tra cuối.
