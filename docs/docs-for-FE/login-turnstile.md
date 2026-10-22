# Cloudflare Turnstile cho đăng nhập

`POST /api/v1/auth/login` bắt buộc gửi thêm `turnstileToken`:

```json
{
  "username": "vedora.user",
  "password": "StrongPassword123!",
  "turnstileToken": "token-do-widget-tra-ve"
}
```

BE kiểm tra Siteverify trước khi tra cứu tài khoản/kiểm tra mật khẩu/cấp token.
Không tin cờ `captchaVerified` từ client. Token phải là chuỗi không rỗng sau trim,
tối đa 2048 ký tự. Thiếu/sai kiểu trả 400; Cloudflare từ chối hoặc không liên lạc
được trả `403` với `code: "CAPTCHA_FAILED"`, không gọi luồng đăng nhập.

Khi CAPTCHA hợp lệ, các response login giữ nguyên: 200 auth response, 401 sai
thông tin hoặc account không ACTIVE, 403 EMAIL_NOT_VERIFIED chuyển sang xác minh
email. FE không được nhầm CAPTCHA_FAILED với EMAIL_NOT_VERIFIED.

## Form và retry

- Hiển thị widget Turnstile dưới mật khẩu, khóa nút đăng nhập trước khi nhận token.
- Gửi token qua Server Action cùng username/password; chỉ BE gọi Siteverify.
- Xóa token khi widget lỗi, timeout hoặc hết hạn. Cho phép xác minh lại.
- Sau mỗi lần submit thất bại, reset widget để nhận token mới, kể cả sai mật khẩu.
  Token dùng một lần và có hạn 300 giây; không cache, log hay tái sử dụng.
- Giữ luồng đăng nhập Google hiện có. CAPTCHA này bảo vệ đăng nhập mật khẩu.

## Cấu hình

FE, trong `.env.local` hoặc biến môi trường của dịch vụ build:

```dotenv
NEXT_PUBLIC_TURNSTILE_SITE_KEY=<public-site-key>
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

BE, trong `.env` hoặc biến môi trường của API:

```dotenv
TURNSTILE_SECRET_KEY=<matching-secret-key>
```

Dùng cặp key của cùng widget đã cấu hình hostname FE trong Cloudflare Turnstile.
Secret chỉ ở BE, tuyệt đối không đặt dưới NEXT_PUBLIC_ hay commit vào Git.
Cấu hình được tái sử dụng với guest nutrition chat. CSP FE đã cho phép script và
iframe từ challenges.cloudflare.com. Phải rebuild FE sau khi đổi public site key.

Trong development, thiếu public key dùng test site key
`1x00000000000000000000AA`; BE thiếu/để trống secret ngoài production dùng test
secret `1x0000000000000000000000000000000AA`. Đây là key công khai chỉ để kiểm thử.
Production không tự fallback: FE thiếu key thì khóa đăng nhập mật khẩu; BE thiếu
secret sẽ không khởi động. Khi deploy production phải cấu hình key thật.

Login đi qua Next Server Action nên BE không gửi socket IP của server FE làm
`remoteip`. Siteverify cho phép bỏ field này; guest chat vẫn dùng IP hiện tại.

## Rollout và kiểm tra

Deploy BE và FE tương thích: client cũ không gửi token sẽ bị 400. Không có
migration hoặc dependency mới. Swagger `/docs` mô tả token trong LoginDto.

```powershell
npm run build
npm run lint
npm run test:e2e -- test/login-turnstile.e2e-spec.ts
npm test -- src/nutrition-chat/guest/turnstile.service.spec.ts
```

Test bao phủ missing/empty/oversized/invalid tokens, không xử lý mật khẩu khi
CAPTCHA bị từ chối, replay rejection, lỗi mạng/timeout/non-2xx, login thành công,
sai mật khẩu và luồng xác minh email. Dùng test key để kiểm thử tự động; test key
always-pass không chứng minh khả năng phát hiện bot hoặc chống replay thật.

Nguồn: [Cloudflare server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
và [test keys](https://developers.cloudflare.com/turnstile/troubleshooting/testing/).
