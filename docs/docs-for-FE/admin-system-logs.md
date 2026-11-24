# Nhật ký hệ thống cho admin

Trang FE: **Hệ thống → Nhật ký hệ thống**, `/admin/system-logs`.

## Phạm vi ghi nhận

- Ghi kết quả yêu cầu HTTP POST/PUT/PATCH/DELETE quản trị do tài khoản ADMIN đang hoạt động thực hiện, sau khi vượt qua guards.
- Bao gồm các controller có `@Roles(ADMIN)` hoặc đường dẫn `admin/*`, thao tác quản lý tài khoản ở `/users`, và xóa bình luận ở `/posts/:postId/comments/:commentId` bởi admin.
- Ghi cả thành công và lỗi trong validation pipes/service/controller: ví dụ 201/200/204, 400/404/409/500. Mỗi yêu cầu có UUID do BE sinh, trả trong header `X-Request-ID`.
- Không ghi các GET, hoạt động cá nhân thông thường như đăng nhập/thích bài/nhắn tin, yêu cầu bị từ chối ở guards, route không tồn tại, cron, webhook hoặc lỗi khởi động hệ thống. Đây là lịch sử quản trị đã xác thực, không phải nhật ký an ninh cho mọi request.
- HTTP 202/thành công chỉ xác nhận kết quả yêu cầu. Việc xử lý nền được tiếp nhận có thể chưa hoàn tất.

## Dữ liệu và riêng tư

Collection MongoDB `system_logs` lưu snapshot ID/username admin, route mẫu (không chứa giá trị URL thực), loại đối tượng và UUID mục tiêu nếu có, phương thức, nhãn thao tác, kết quả, HTTP status, error code, thời gian xử lý và thời điểm.

Chỉ lấy các enum cho quyết định, trạng thái/quyền được yêu cầu từ allowlist. Với thao tác thất bại, đây **không phải trạng thái đã áp dụng**. Không lưu request/response body, query, header, mật khẩu/token, nội dung bình luận, lý do xử lý, thông báo lỗi hoặc stack trace.

Không có API tạo/sửa/xóa nhật ký. Không TTL hoặc backfill lịch sử cũ. Snapshot được giữ khi admin đổi username hoặc bị xóa. Quyền truy cập DB vẫn có thể thay đổi dữ liệu; không coi collection này là bằng chứng chống sửa ở cấp hạ tầng.

`UserAccountAudit` hiện có vẫn giữ nguyên trong transaction nghiệp vụ tài khoản. Nhật ký HTTP chung được ghi sau kết quả nghiệp vụ, với thời gian chờ giới hạn; nếu ghi thất bại thì cảnh báo máy chủ chứa request ID/route mẫu, không đổi kết quả nghiệp vụ. Vì vậy nó có thể thiếu bản ghi khi tiến trình/DB gặp sự cố; không bảo đảm giao dịch nguyên tử với tất cả nghiệp vụ. Lệnh ghi bị quá thời gian chờ có thể hoàn thành muộn.

## API (prefix mặc định `/api/v1`)

Chỉ ADMIN; Bearer access token. USER nhận 403, chưa đăng nhập nhận 401.

### `GET /admin/system-logs`

| Query | Ý nghĩa |
| --- | --- |
| `page`, `limit` | Phân trang từ BE; mặc định 1/20, tối đa 50 dòng theo cấu hình pagination hiện có |
| `q` | Tìm chuỗi literal trong username, nhãn/thao tác, target ID và request ID; mặc định tối đa 100 ký tự |
| `outcome` | `SUCCESS` hoặc `FAILURE` |
| `resourceType` | Enum tài nguyên trong Swagger/SystemLogDto |
| `actorId`, `targetId`, `requestId` | Lọc chính xác UUID |
| `from`, `to` | ISO timestamp có timezone, hai biên bao gồm; `from > to` trả 400 |

Ví dụ: `/admin/system-logs?outcome=FAILURE&page=1&limit=20`.

Response `{ items: SystemLogDto[], meta: { page, limit, totalItems, totalPages, hasNextPage, hasPreviousPage } }`.
Sắp xếp mới nhất trước theo `createdAt`, rồi `_id`; FE không sắp xếp riêng từng trang. Page pagination không tạo snapshot cố định: khi có log mới, vị trí giữa các lần tải có thể dịch chuyển.

### `GET /admin/system-logs/:id`

Trả `SystemLogDto`, 400 nếu ID không hợp lệ, 404 nếu không có bản ghi. Các trường nullable: `targetId`, `errorCode`, `decision`, `targetStatus`, `targetRole`.

## Cấu hình và triển khai

Các biến tùy chọn mới, giữ mặc định khi chưa khai báo:

```dotenv
SYSTEM_LOG_QUERY_MAX_LENGTH=100
SYSTEM_LOG_WRITE_TIMEOUT_MS=2000
SYSTEM_LOG_QUERY_TIMEOUT_MS=5000
```

Docker Compose đã chuyển tiếp các biến này. Không cần thêm khóa bí mật, migration hay seed; model/index được đăng ký qua MongoModule. Deploy BE trước FE. Nhật ký bắt đầu từ lúc BE có tính năng chạy; không dựng lại lịch sử trước đó từ commit hoặc `UserAccountAudit`.

## Kiểm tra

```sh
npm run build
npm run lint
npx vitest run test/unit/admin-system-logs
npx vitest run --config vitest.config.e2e.mts test/e2e/admin-system-logs.e2e-spec.ts
```

HTTP tests sử dụng DB riêng trên MongoDB replica set của bộ test. Unit tests kiểm tra giới hạn thời gian ghi, allowlist và phạm vi riêng tư. Docker smoke chạy image production với credential giả, gọi HTTP và kiểm tra trực tiếp bản ghi MongoDB, không gọi nhà cung cấp AI/mail.
