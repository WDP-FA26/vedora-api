# Tổng quan công việc quản trị và badge

Trang FE `/admin/overview` là trang đầu khi mở khu vực `/admin`. Trang thống kê theo ngày `/admin/insights` tiếp tục dùng API dashboard cũ.

## API

`GET /api/v1/admin/dashboard/work-queue`, chỉ ADMIN đang hoạt động. Guest nhận 401, member nhận 403, token tự ghi claim ADMIN không vượt qua việc kiểm tra role hiện tại trong DB. Response có `Cache-Control: private, no-store`, `Vary: Authorization` vì số hồ sơ được giao phụ thuộc admin đang đăng nhập.

Response:

```ts
{
  generatedAt: string;
  refreshAfterSeconds: number;
  previewLimit: number;
  counts: {
    POST_REVIEW: number;
    POST_REPORTS: number;
    COMMENT_REPORTS: number;
    VERIFICATION: number;
    WORKSPACES: number;
    SUPPORT: number;
    KNOWLEDGE: number;
  };
  badges: { total: number; moderation: number; verification: number; workspaces: number; support: number; knowledge: number };
  support: { appeals: number; assignedToMe: number };
  items: { kind: "POST_REVIEW" | "POST_REPORTS" | "COMMENT_REPORTS" | "VERIFICATION" | "WORKSPACES" | "SUPPORT" | "KNOWLEDGE"; id: string; title: string; createdAt: string | null; sourceCount: number }[];
}
```

Số đếm là snapshot **toàn bộ hàng đợi hiện tại**, không giới hạn bởi khoảng ngày thống kê hoặc danh sách xem trước. Mỗi nhóm dùng aggregate/facet để đếm và lấy preview trong cùng truy vấn; các nhóm đọc song song, không phải transaction snapshot chung. Có thể có thay đổi nghiệp vụ giữa hai truy vấn/phiên đọc; FE lấy lại dữ liệu sau thao tác và định kỳ.

| Nhóm | Điều kiện | Đơn vị |
| --- | --- | --- |
| POST_REVIEW | Post `PENDING_REVIEW` | Bài viết/blog |
| POST_REPORTS | PostReport `PENDING`, bài còn tồn tại | Bài được báo cáo, không phải từng lượt |
| COMMENT_REPORTS | CommentReport `PENDING` | Bình luận được báo cáo, không phải từng lượt |
| VERIFICATION | VerificationRequest `PENDING` | Hồ sơ xác minh |
| WORKSPACES | Workspace `PENDING` | Đơn trang nhà hàng |
| SUPPORT | SupportTicket `OPEN` | Hồ sơ hỗ trợ/kháng cáo |
| KNOWLEDGE | KnowledgeDocument `AWAITING_REVIEW` | Tài liệu chờ duyệt |

`support.appeals` là phần CONTENT_APPEAL trong SUPPORT, không cộng thêm vào tổng. `assignedToMe` chỉ đếm hồ sơ OPEN có assigneeId là admin từ JWT đã được xác thực.

`moderation = POST_REVIEW + POST_REPORTS - số bài nằm ở cả hai nhóm + COMMENT_REPORTS`.
`total = moderation + verification + workspaces + support + knowledge`.

Không lấy tổng bằng cách cộng thẳng 7 ô danh mục: một bài vừa chờ duyệt vừa bị báo cáo chỉ là một việc kiểm duyệt. Hồ sơ WAITING_USER, báo cáo đã xử lý/bỏ qua, hồ sơ đã duyệt/từ chối, tài liệu đang chạy hoặc đã sẵn sàng không tính là việc chờ admin. Đơn thanh toán PENDING, tài khoản chờ xác minh email và nhật ký lỗi không có quy trình đóng việc quản trị riêng nên không tạo badge giả; khi người dùng mở hồ sơ hỗ trợ thanh toán, nó nằm trong SUPPORT.

## Danh sách xem trước

Tối đa 10 việc, sắp xếp thời điểm cũ trước rồi kind/id để thứ tự ổn định. Post dùng createdAt; báo cáo dùng thời điểm lượt đang chờ sớm nhất; hỗ trợ dùng lastMessageAt; các hồ sơ/tài liệu dùng createdAt. Đây là thời điểm của dữ liệu nguồn, không phải phép đo SLA hoặc thời gian chờ chính xác từ lần chuyển trạng thái.

Preview gộp bài ở hai nhóm thành POST_REVIEW; POST_REPORTS.id là post ID, COMMENT_REPORTS.id là report ID đại diện để mở khung xử lý, các nhóm khác là ID đối tượng tương ứng. `sourceCount` cho biết số lượt báo cáo PENDING trên cùng nội dung (nhóm báo cáo), các nhóm khác bằng 1. Tiêu đề được rút gọn, không trả statements, địa chỉ nhà hàng, khóa storage, nội dung hội thoại, thông tin thanh toán hoặc credentials. GET không sinh nhật ký mutation.

FE có liên kết trực tiếp đến đúng tab/view và hồ sơ. Tìm/sắp xếp trong bảng overview chỉ áp dụng cho preview đã tải; mở danh mục để xem toàn bộ hàng đợi.

## Cập nhật badge

Admin layout dùng một provider và một SWR key chung cho dashboard/menu. Sau khi API mutation nhận phản hồi, sự kiện trình duyệt không chứa payload/URL/token yêu cầu tải lại sau debounce 200 ms, kể cả khi thao tác gặp xung đột. Badge cũng được tải lại khi đổi trang, lấy lại focus và mỗi 30 giây khi tab đang hiển thị/online. Thay đổi từ admin hoặc tab khác xuất hiện ở lần làm mới tiếp theo; không phải SSE.

Chỉ hiển thị badge số khi lớn hơn 0, số lớn hơn 99 hiển thị 99+ nhưng tên truy cập/title giữ số đầy đủ. Lỗi tải hiển thị dấu ! và thông báo chưa xác định, không giả lập 0. Tổng quan, Bài đăng, Kiểm duyệt, Xác minh, Trang nhà hàng, Hỗ trợ và Tài liệu có số đếm tương ứng.

## Env mới, tùy chọn

```dotenv
ADMIN_WORK_PREVIEW_LIMIT=10
ADMIN_WORK_REFRESH_SECONDS=30
ADMIN_WORK_QUERY_TIMEOUT_MS=5000
ADMIN_WORK_TITLE_MAX_LENGTH=120
```

Giới hạn lần lượt: 1–50; 5–3600 giây; 100–30000 ms; 10–500 ký tự. Startup từ chối giá trị ngoài khoảng. Docker Compose đã chuyển tiếp, không cần migration/seed hoặc khóa mới. Deploy BE trước FE.

## Validation

```sh
npm run build
npm run lint
npx vitest run --config vitest.config.e2e.mts test/e2e/admin-work-queue.e2e-spec.ts
npx vitest run test/unit/admin-dashboard/work-queue-config.spec.ts
```

Bộ test mặc định dùng `mongo-test` tại port 27018 (`docker compose up -d mongo-test`), hoặc `TEST_DATABASE_URL` cho MongoDB replica set riêng. Mỗi spec tạo DB riêng và tự xóa. Docker smoke đã chạy production image với MongoDB thật: 7 hàng đợi, trùng bài/lượt báo cáo, loại WAITING_USER, số giao cho từng admin, phân quyền, cache private, metadata và cập nhật sau xử lý; dùng credential provider giả, không gọi AI/mail.
