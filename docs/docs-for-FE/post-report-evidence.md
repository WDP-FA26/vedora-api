# Báo cáo bài viết: ảnh minh chứng và số lượt báo cáo

Admin mở **Nội dung → Kiểm duyệt → Bài viết → Bị báo cáo**. Mỗi bài có một dòng, hiển thị tổng lượt báo cáo và số lượt còn chờ. Bấm **Xem**, kéo đến **Báo cáo của bài viết** để xem từng người gửi, lý do, chi tiết, trạng thái và ảnh minh chứng. Xử lý từng báo cáo tại đây; khi có nhiều lượt đang chờ, bảng không hiển thị nút nhanh có thể bị hiểu nhầm là xử lý cả nhóm.

## Gửi báo cáo

1. Người dùng có thể chọn tối đa 3 ảnh JPG/PNG/WebP, mỗi ảnh tối đa 5 MB (mặc định). Không bắt buộc có ảnh.
2. `POST /api/v1/posts/:postId/report/evidence`, Bearer token cá nhân, multipart form field **file** (một file mỗi request), trả 201 `{ id: UUID }`.
3. `POST /api/v1/posts/:postId/report` với `{ reason, details?, evidenceIds?: UUID[] }`. `evidenceIds` không trùng, tối đa 3. Receipt vẫn không trả danh tính người báo cáo hoặc URL minh chứng.

BE kiểm tra tài khoản, bài đang công khai, không phải bài của người gửi, kích thước/MIME và chữ ký định dạng ảnh. Dữ liệu được gửi qua API vào bucket riêng tư `STORAGE_SUPPORT_BUCKET` hiện có, prefix riêng `post-report-evidence/`. Không sử dụng URL ảnh công khai hoặc chấp nhận URL do client tự điền; không cấp signed PUT cho phép ghi đè file đã nộp. Ảnh không phải JPG/PNG/WebP nhận 415, thiếu file/ID sai nhận 400, quá dung lượng nhận 413.

Ảnh chỉ được gắn vào báo cáo của đúng chủ sở hữu và đúng bài, chưa dùng và chưa hết hạn. Việc tạo báo cáo có ảnh và gắn ảnh nằm trong cùng transaction MongoDB; có lỗi sẽ rollback. Một người vẫn chỉ báo cáo một lần/bài nhờ unique index hiện có; gửi trùng nhận 409 `ALREADY_REPORTED`.

Luồng báo cáo bình luận giữ nguyên, không nhận `evidenceIds`. Ảnh tải thành công được FE giữ ID trong lần mở form để thử gửi báo cáo lại mà không tải lại file. Hủy/đóng form giải phóng preview và bỏ các ID tại client; ảnh chưa gửi được dọn theo lịch.

## Admin đọc và đếm báo cáo

`GET /api/v1/admin/reports` hỗ trợ thêm `postId=UUID`, cùng `status`, `page`, `limit` hiện có. Chỉ ADMIN đọc được.

Mỗi item thêm:

```ts
{
  reportCount: number;        // mọi trạng thái của cùng bài, không chỉ trang/bộ lọc hiện tại
  pendingReportCount: number; // số báo cáo PENDING của cùng bài
  evidence: { id: string; url: string; contentType: string; sizeBytes: number }[];
}
```

Tổng lượt tương ứng số người đã báo cáo trong dữ liệu còn lưu, không tăng khi họ gửi lại request. Bỏ qua/xử lý một báo cáo chỉ giảm số chờ, không giảm tổng. Gỡ bài bằng chức năng admin hiện có sẽ resolve tất cả báo cáo đang chờ và giữ ảnh/lịch sử để xem lại. Đây là gỡ mềm; hành vi xóa cứng/cascade hiện có không thay đổi.

URL ảnh là signed GET, mặc định 15 phút. Người ngoài không thể tải object bằng URL không có chữ ký. Không đưa URL/danh tính người gửi vào API bài viết công khai hoặc thông báo cho chủ bài. Khung chi tiết FE tải lại dữ liệu mỗi 5 phút khi mở và sau thao tác xử lý; các bộ đếm trong bảng cũng được cập nhật. Các trang sử dụng chung DataTable/Sheet và bộ chọn ảnh hiện có.

## Biến môi trường mới (tùy chọn)

```dotenv
REPORT_MAX_EVIDENCE_IMAGES=3
REPORT_EVIDENCE_MAX_MB=5
REPORT_EVIDENCE_URL_TTL_SECONDS=900
REPORT_EVIDENCE_MAX_PENDING_UPLOADS=12
REPORT_EVIDENCE_CLEANUP_AGE_SECONDS=86400
REPORT_EVIDENCE_CLEANUP_BATCH_SIZE=100
REPORT_EVIDENCE_CLEANUP_CRON="0 45 * * * *"
```

Docker Compose đã chuyển tiếp các biến này. Cấu hình giới hạn ảnh được công bố qua `GET /public-config` tại `uploads.reportMaxEvidenceImages` và `uploads.reportEvidenceMaxMb`; giao diện hiện dùng mặc định tương ứng 3/5. Nếu tùy chỉnh giới hạn, cần đồng bộ props của bộ chọn ảnh FE.

Không cần bucket/credentials mới nếu storage hỗ trợ đang hoạt động. Khi chưa cấu hình storage, vẫn gửi báo cáo không ảnh được; tải ảnh nhận 503. Deploy BE trước FE. Model/index `PostReportEvidence` tự đăng ký, không cần migration dữ liệu cũ. File chưa được gắn sau 24 giờ hết hiệu lực, cron phút 45 mỗi giờ dọn tối đa 100 file/lượt. File đã gắn không bị lịch dọn nháp này xóa.

## Kiểm tra

```sh
npm run build
npm run lint
npx vitest run --config vitest.config.e2e.mts test/e2e/post-report-evidence.e2e-spec.ts
npx vitest run test/unit/posts/interactions/post-reports.service.spec.ts
```

HTTP tests dùng MongoDB thật và giả lập lớp lưu trữ để kiểm tra transaction, quyền, riêng tư, nhiều người báo cáo, phân trang/trạng thái, ID ảnh sai chủ/bài, upload hết hạn, gửi đồng thời, định dạng/dung lượng và gỡ mềm. Docker smoke riêng đã chạy production API + MongoDB + RustFS 1.0.1, tải multipart thật, đọc đúng byte ảnh qua signed URL và xác nhận URL không chữ ký bị từ chối.
