# Lỗi API

Mọi response lỗi (4xx/5xx) dùng cùng một cấu trúc:

```json
{
  "statusCode": 409,
  "code": "PENDING_PAYMENT_CONFLICT",
  "message": "Pending payment exists",
  "details": { }
}
```

- `statusCode`: trùng HTTP status của response.
- `code`: mã máy đọc, luôn có. FE rẽ nhánh xử lý theo `code`, không theo `message`.
- `message`: chuỗi mô tả để debug. Không hiển thị thẳng cho người dùng và không dùng để so sánh. Lỗi validation nối các thông báo bằng `; `.
- `details`: field riêng của một số mã (bảng bên dưới). Không có thì field bị bỏ.

Thay đổi so với body mặc định của NestJS trước đây: không còn `error`; `message` không còn là mảng (mảng nằm trong `details.messages` với lỗi validation); các field nghiệp vụ như `email`, `problems`, `recipeIds` nằm trong `details`. Mã và HTTP status của các lỗi nghiệp vụ hiện có không đổi.

## Mã lỗi

### 400

| `code` | Ý nghĩa | `details` |
| --- | --- | --- |
| `VALIDATION_FAILED` | Body/query không hợp lệ | `messages: string[]` — từng lỗi validation, lỗi lồng nhau có đường dẫn (ví dụ `messages.0.role ...`) |
| `BAD_REQUEST` | Yêu cầu sai, không có mã riêng | — |
| `EMPTY_POST` | Bài viết không có chữ và không có video | — |
| `OWN_POST` | Báo cáo bài của chính mình | — |
| `MEDIA_UNAVAILABLE` | Media chưa sẵn sàng hoặc đã dùng ở bài khác | — |
| `INVALID_DASHBOARD_RANGE` | Khoảng ngày dashboard sai | — |
| `BLOG_AI_INVALID_MESSAGES` | Lịch sử chat trợ lý blog không hợp lệ | — |
| `BLOG_CONTENT_REQUIRED` | Blog xuất bản cần nội dung | — |
| `BLOG_COVER_NOT_ALLOWED` | Ảnh bìa không phải https hoặc không thuộc kho blog | — |
| `BLOG_RECIPE_NOT_FOUND` | Có công thức liên kết không tồn tại | `recipeIds: string[]` — các ID không tồn tại |
| `UNKNOWN_REFERENCE` | Có ID nguyên liệu/nhóm/công thức không tồn tại | — |
| `CONFLICTING_PREFERENCE` | Nguyên liệu vừa thích vừa tránh | — |
| `SAME_INGREDIENT` | Quy tắc xung đột với chính nguyên liệu đó | — |

### 401

| `code` | Ý nghĩa | `details` |
| --- | --- | --- |
| `UNAUTHORIZED` | Chưa đăng nhập hoặc token không hợp lệ | — |
| `ACCOUNT_SUSPENDED` | Tài khoản bị đình chỉ | — |
| `ACCOUNT_NOT_ACTIVE` | Tài khoản không ở trạng thái hoạt động | — |

### 403

| `code` | Ý nghĩa | `details` |
| --- | --- | --- |
| `FORBIDDEN` | Không có quyền | — |
| `EMAIL_NOT_VERIFIED` | Email chưa xác minh (đăng nhập đúng mật khẩu hoặc đánh giá công thức) | `email: string` |
| `CAPTCHA_FAILED` | Xác minh Turnstile thất bại | — |
| `SELF_RATING_NOT_ALLOWED` | Tự đánh giá công thức của mình | — |

### 404

| `code` | Ý nghĩa | `details` |
| --- | --- | --- |
| `NOT_FOUND` | Tài nguyên không tồn tại hoặc không xem được | — |

### 409

| `code` | Ý nghĩa | `details` |
| --- | --- | --- |
| `CONFLICT` | Xung đột chung (ví dụ trùng tên, trùng dữ liệu duy nhất) | — |
| `MEAL_PLAN_INVALID` | Thực đơn vi phạm chế độ ăn hoặc quy tắc xung đột khi lưu | `problems: MealPlanProblem[]` — xem [recipe-catalog-meal-plan.md](recipe-catalog-meal-plan.md) |
| `ALREADY_VERIFIED` | Tài khoản đã được xác minh | — |
| `PROOF_NOT_UPLOADED` | Ảnh minh chứng chưa tải lên xong | — |
| `REQUEST_PENDING` | Đã có yêu cầu xác minh đang chờ duyệt | — |
| `ALREADY_REPORTED` | Đã báo cáo bài này | — |
| `INVALID_ACCOUNT_TRANSITION` | Không thể đình chỉ/kích hoạt lại trạng thái này | — |
| `ACCOUNT_VERSION_CONFLICT` | Tài khoản đã đổi; tải lại trước khi thử lại | — |
| `LAST_ACTIVE_ADMIN` | Phải còn ít nhất một admin hoạt động | — |
| `RULE_EXISTS` | Đã có quy tắc cho cặp nguyên liệu này | — |
| `NAME_TAKEN` | Tên đã được dùng | — |
| `INGREDIENT_IN_USE` | Nguyên liệu còn được dùng trong công thức | — |
| `IDEMPOTENCY_CONFLICT` | `Idempotency-Key` đã dùng cho yêu cầu khác | — |
| `ACCOUNT_NOT_PAYABLE` | Tài khoản không thể thanh toán | — |
| `PENDING_PAYMENT_CONFLICT` | Đang có giao dịch chờ thanh toán | — |
| `PAYMENT_NOT_PENDING` | Giao dịch không còn ở trạng thái chờ | — |
| `CAPTURE_CONFLICT` | Giao dịch đã thay đổi khi nhận callback | — |
| `FAVORITE_CONFLICT` | Yêu thích công thức bị xung đột khi ghi đồng thời; tải lại và thử lại | — |
| `RATING_CONFLICT` | Đánh giá bị xung đột khi ghi đồng thời; tải lại và thử lại | — |
| `MEAL_PLAN_CONFLICT` | Thực đơn bị xung đột khi lưu đồng thời; tải lại và lưu lại | — |

### 413 / 415

| `code` | HTTP | Ý nghĩa |
| --- | --- | --- |
| `FILE_TOO_LARGE` | 413 | File vượt giới hạn (ảnh hồ sơ, minh chứng, tài liệu) |
| `UNSUPPORTED_FILE_TYPE` | 415 | Loại file không được chấp nhận |

### 429

| `code` | Ý nghĩa | `details` |
| --- | --- | --- |
| `TOO_MANY_REQUESTS` | Gửi quá nhiều yêu cầu | — |
| `AI_QUOTA_EXCEEDED` | Hết lượt trợ lý AI trong ngày | — |
| `GUEST_QUOTA_REACHED` | Khách hết lượt chat trong ngày | — |
| `UPLOAD_LIMIT_REACHED` | Quá nhiều media chưa gắn vào bài | — |
| `PROOF_LIMIT_REACHED` | Quá nhiều ảnh minh chứng chưa gửi | — |
| `VERIFY_LIMIT_REACHED` | Nhập sai mã quá nhiều lần; thử lại sau | — |
| `RESEND_LIMIT_REACHED` | Gửi lại mã quá nhiều lần; thử lại sau | — |

### 500 / 502 / 503

| HTTP | `code` | Ý nghĩa | `details` |
| --- | --- | --- | --- |
| 500 | `INTERNAL_ERROR` | Lỗi không mong đợi phía server | — |
| 502 | `EXTERNAL_SERVICE_FAILED` | Dịch vụ bên thứ ba (OpenRouter, Qdrant, Cloudinary) lỗi | `service: "openrouter" \| "qdrant" \| "cloudinary"` |
| 503 | `SERVICE_UNAVAILABLE` | Tính năng tạm thời không sẵn sàng | — |
| 503 | `PAYMENTS_DISABLED` | Thanh toán SePay chưa bật | — |
| 503 | `PAYMENT_CODE_UNAVAILABLE` | Không cấp được mã thanh toán; thử lại với cùng `Idempotency-Key` | — |
| 503 | `GUEST_CHAT_CLOSED` | Chat khách đã đóng trong ngày | — |

Lưu ý: trước đây lỗi từ dịch vụ bên thứ ba trả 500; hiện trả 502 với `EXTERNAL_SERVICE_FAILED`. Chi tiết kỹ thuật chỉ được ghi ở server log.

## Cách FE dùng

- Rẽ nhánh theo `code`, không theo `message`.
- Với `409`/`429`/`403` có `details`, đọc `details` đúng tên field ở bảng trên.
- Validation: hiển thị `details.messages` nếu cần từng lỗi, hoặc `message` cho một chuỗi gộp.
- Đăng nhập trả `403 EMAIL_NOT_VERIFIED` kèm `details.email`: chuyển sang bước xác minh email.
