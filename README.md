# Vedora API

Backend starter cho Vedora, sử dụng NestJS, Mongoose (MongoDB, tự host bằng Docker Compose) và Docker. Repository có sẵn cấu hình để chạy local hoặc triển khai bằng Docker Compose trên Dokploy.

## Thành phần

- NestJS 11 + TypeScript
- `@nestjs/mongoose` + Mongoose 9 trên MongoDB 8 (replica set một node, bật xác thực bằng keyfile)
- Swagger/OpenAPI tại `/docs`
- Validation request, CORS và security headers
- Health check tách liveness/readiness
- Schema Mongoose khai báo collection và index; API tạo chúng khi khởi động (MongoDB không có migration)
- Docker image multi-stage, chạy bằng non-root user
- Docker Compose cho local và Dokploy

## Cấu trúc chính

```text
.
├── seed-data/
│   └── recipes.json           # Danh mục khởi đầu (nguyên liệu, nhóm, quy tắc, công thức)
├── src/
│   ├── ai/                    # Hạ tầng AI dùng chung: model OpenRouter, moderation, quota, tool tra cứu
│   ├── common/pagination/     # DTO, helper và Swagger cho phân trang dùng chung
│   ├── config/                # Validate biến môi trường
│   ├── mongo/                 # MongoModule, MongoService, schema và type dùng chung
│   ├── auth/ users/ profiles/ # Tài khoản, hồ sơ và quan hệ theo dõi
│   ├── posts/                 # Bài ngắn, blog, bình luận, tìm kiếm và quản trị
│   │   ├── blogs/             # Blog, ảnh bìa và trợ lý AI viết bài
│   │   ├── interactions/      # Bình luận, like và báo cáo
│   │   ├── admin/             # Duyệt bài và xử lý báo cáo
│   │   └── search/            # Tìm kiếm và feed "dành cho bạn" trên Qdrant
│   ├── media/                 # Upload video, webhook, phụ đề Whisper, dọn dẹp định kỳ
│   ├── recipes/ meal-plan/    # Danh mục công thức, thực đơn và đi chợ
│   ├── knowledge/ nutrition-chat/
│   ├── payments/ notifications/ verification/
│   ├── admin-dashboard/ health/ cloudinary/ storage/ qdrant/ mail/
│   ├── app.module.ts
│   └── main.ts
├── Dockerfile
├── docker-compose.yml         # Chạy local
└── docker-compose.dokploy.yml # Deploy trên Dokploy
```

`src/ai` và `src/config` là tầng nền, không được import ngược vào feature nào; chiều phụ thuộc là feature → `ai`/`config`. ESLint chặn việc này (`no-restricted-imports` trong `eslint.config.mjs`), cùng với các đường dẫn cũ như `post-search/`, `ai-usage/` và `posts/ai/`.

## Chạy local không dùng Docker cho API

Yêu cầu Node.js `>=20.11`, npm và MongoDB chạy dưới dạng replica set (transaction của MongoDB cần replica set). Cách nhanh nhất: `docker compose up -d mongo`.

```bash
cp .env.example .env
npm install
npm run seed
npm run start:dev
```

Trên PowerShell, thay lệnh copy bằng:

```powershell
Copy-Item .env.example .env
```

## Chạy toàn bộ bằng Docker

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f api
```

Các URL mặc định:

- API: <http://localhost:3000/api/v1>
- Swagger: <http://localhost:3000/docs>
- Liveness: <http://localhost:3000/api/v1/health>
- Readiness (kiểm tra cả DB): <http://localhost:3000/api/v1/health/ready>

Dừng container:

```bash
docker compose down
```

Không thêm `-v` nếu muốn giữ dữ liệu MongoDB. `docker compose down -v` sẽ xóa volume database.

## API mẫu

| Method | Endpoint | Mô tả |
| --- | --- | --- |
| `GET` | `/api/v1` | Thông tin API |
| `GET` | `/api/v1/health` | Liveness |
| `GET` | `/api/v1/health/ready` | Readiness + MongoDB |
| `POST` | `/api/v1/auth/register` | Đăng ký và gửi mã xác minh email; chưa trả token |
| `POST` | `/api/v1/auth/login` | Đăng nhập bằng username/password và nhận cặp AT/RT |
| `POST` | `/api/v1/auth/password/forgot` | Gửi mã đặt lại mật khẩu tới email (luôn trả `204`) |
| `POST` | `/api/v1/auth/password/reset` | Đặt mật khẩu mới bằng mã trong email và thu hồi mọi phiên đăng nhập |
| `POST` | `/api/v1/auth/refresh` | Rotate refresh token và nhận cặp AT/RT mới |
| `POST` | `/api/v1/auth/logout` | Thu hồi refresh-token family |
| `POST` | `/api/v1/auth/google/authorize` | Bắt đầu đăng nhập Google: URL, `state`, `codeVerifier` (PKCE) |
| `POST` | `/api/v1/auth/google` | Đổi `code` + `codeVerifier` (PKCE) lấy cặp AT/RT |
| `GET` | `/api/v1/auth/me` | Thông tin user hiện tại (Bearer token) |
| `POST` | `/api/v1/users` | Tạo user (Bearer token) |
| `GET` | `/api/v1/users` | Danh sách user phân trang `page`/`limit` (Bearer token) |
| `GET` | `/api/v1/users/:id` | Chi tiết user (Bearer token) |
| `PATCH` | `/api/v1/users/:id` | Cập nhật user (Bearer token) |
| `DELETE` | `/api/v1/users/:id` | Xóa user (Bearer token) |

Ví dụ:

```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{"username":"vedora.user","password":"StrongPassword123!","fullName":"Vedora User","email":"hello@vedora.vn"}'
```

Đăng ký **không** trả token: API tạo tài khoản chưa xác minh và gửi mã 6 chữ số tới email
(qua Resend). Gọi `POST /api/v1/auth/verify-email` với `email` và `code` để nhận token.
Mã hết hạn sau 10 phút, sai tối đa 5 lần; `POST /api/v1/auth/verify-email/resend` gửi mã
mới sau mỗi 120 giây, tối đa 3 lần trong 1 giờ kể từ mã đầu tiên (quá giới hạn trả `429`
với `code: "RESEND_LIMIT_REACHED"`). Đăng nhập đúng mật khẩu nhưng email chưa xác minh trả `403`
với `code: "EMAIL_NOT_VERIFIED"` và tự gửi mã mới. Tài khoản chưa xác minh quá 1 giờ sẽ
nhường email và username cho người đăng ký sau.

Quên mật khẩu: `POST /api/v1/auth/password/forgot` với `email` gửi mã 6 chữ số, cùng giới hạn
gửi lại như mã xác minh, và luôn trả `204` kể cả khi email chưa đăng ký. Sau đó
`POST /api/v1/auth/password/reset` với `email`, `code` và `password` mới đặt lại mật khẩu (`204`),
đồng thời xác minh email nếu chưa xác minh và thu hồi mọi refresh token, nên người dùng phải
đăng nhập lại. Mã sai trả `400`; số lần đoán sai được tính chung với mã xác minh, tối đa 15
lần mỗi ngày cho mỗi email (quá giới hạn trả `429` với `code: "VERIFY_LIMIT_REACHED"`).

Khi chạy local không có `RESEND_API_KEY`, mã được in ra log của API thay vì gửi email.
Production bắt buộc có `RESEND_API_KEY`; `MAIL_FROM` phải thuộc domain đã xác minh trên
Resend (địa chỉ mặc định `onboarding@resend.dev` chỉ gửi được tới email chủ tài khoản Resend).

Xác minh email, đăng nhập và `POST /auth/google` trả về `accessToken` cùng `refreshToken`.
Gửi access token cho endpoint cần xác thực bằng header
`Authorization: Bearer <accessToken>`. Access token mặc định hết hạn sau 3600 giây,
refresh token sau 30 ngày.

Refresh token là token opaque, chỉ hash SHA-256 được lưu trong database. Mỗi lần gọi
`POST /auth/refresh`, token cũ bị thu hồi và một refresh token mới được phát. Nếu token
cũ bị dùng lại, toàn bộ token family sẽ bị thu hồi và client phải đăng nhập lại.

```bash
curl -X POST http://localhost:3000/api/v1/auth/refresh \
  -H "Content-Type: application/json" \
  -d '{"refreshToken":"REFRESH_TOKEN_HIEN_TAI"}'
```

### Đăng nhập Google

Google chuyển hướng về **frontend**, không về API. Luồng:

1. Frontend (`/auth/google`) gọi `POST /api/v1/auth/google/authorize`, lưu `state` và
   PKCE `codeVerifier` vào cookie httpOnly, rồi chuyển trình duyệt tới `url` của Google.
2. Google chuyển hướng về `GOOGLE_CALLBACK_URL` (frontend) kèm `code` và `state`.
3. Frontend kiểm tra `state`, rồi gọi `POST /api/v1/auth/google` với `code` và `codeVerifier`.
   API đổi code với Google và trả về cặp AT/RT cho server frontend.

Cài đặt:

1. Tạo OAuth 2.0 Client loại **Web application** trong Google Cloud Console.
2. Thêm Authorized redirect URI đúng bằng `GOOGLE_CALLBACK_URL`, tức URL `/auth/google`
   của frontend: local là `http://localhost:3000/auth/google`.
3. Điền `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` và `GOOGLE_CALLBACK_URL` vào `.env`.

Nếu chưa khai báo Google credentials, các route Google trả `503` nhưng các phương thức
đăng nhập khác vẫn hoạt động. API chỉ liên kết tài khoản khi Google trả về email đã xác minh. Nếu email đó thuộc một
tài khoản mật khẩu chưa xác minh, API xoá mật khẩu và thu hồi mọi phiên của tài khoản đó
trước khi liên kết, để người đăng ký hộ email của người khác không giữ được quyền truy cập.

### Bài đăng có video (Cloudinary)

File video đi thẳng từ trình duyệt lên Cloudinary, không qua API:

1. `POST /api/v1/media/uploads` với `{"type":"VIDEO"}` trả về `media` (có `id`,
   `publicId`) và `upload`: `{ url, fields, chunkSize }`. `fields` đã được API ký (cố định
   `public_id` và job eager tạo HLS `sp_auto/m3u8`), chữ ký hết hạn sau 1 giờ.
2. Trình duyệt `POST` multipart lên `upload.url` với mọi `fields` cộng `file`. File lớn hơn
   `chunkSize` gửi theo từng phần, mỗi phần kèm header `X-Unique-Upload-Id` (giống nhau)
   và `Content-Range: bytes <start>-<end>/<total>`. Gói Free giới hạn 100 MB mỗi video.
3. `POST /api/v1/posts` với `{"type":"POST","body":"…","mediaIds":["<media.id>"]}` được
   gọi ngay. Bài ở trạng thái `PROCESSING` (chỉ tác giả thấy) rồi chuyển sang
   `PUBLISHED` khi luồng HLS đã tạo xong, hoặc `FAILED` (ví dụ video dài hơn
   `MAX_VIDEO_DURATION_SEC`).
4. Frontend poll `GET /api/v1/posts/:id` tới khi hết `PROCESSING`, rồi phát video bằng
   `publicId` (next-cloudinary `CldVideoPlayer`, `sourceTypes: ["hls"]`, streaming
   profile `auto`) hoặc trực tiếp `playbackUrl` (`.m3u8`). `posterUrl` là khung hình đầu.

Trạng thái media: `WAITING_UPLOAD` → (thông báo `upload`, ghi `durationSec`,
`aspectRatio`) `PROCESSING` → (thông báo `eager`, HLS đã tạo) `READY`.

Cloudinary báo tiến trình qua webhook `POST /api/v1/webhooks/cloudinary`. Trong
Cloudinary Console → Settings → Webhook Notifications, thêm URL đó với loại **Upload** và
**Eager**, rồi đặt `CLOUDINARY_WEBHOOKS_ENABLED=true`. Chữ ký (`X-Cld-Signature`,
`X-Cld-Timestamp`) được kiểm bằng `CLOUDINARY_API_SECRET`, chấp nhận cả SHA-1 lẫn
SHA-256. Local có thể mở cổng bằng `cloudflared tunnel --url http://localhost:4000`
(URL `trycloudflare.com` đổi mỗi lần chạy, nhớ cập nhật lại trong Console). Khi
`CLOUDINARY_WEBHOOKS_ENABLED=false`, API tự hỏi Admin API (tối đa 15 giây một lần cho mỗi
video, vì Admin API chỉ cho 500 lệnh/giờ) mỗi lần media/bài đang chờ được đọc. Một cron
10 phút một lần cũng cập nhật media bị lỡ webhook, và cron hằng giờ xoá upload không được
gắn vào bài nào sau 24 giờ. File tải xong sau khi upload đã bị huỷ sẽ bị xoá khi thông
báo `upload` tới.

Khi `CAPTIONS_ENABLED=true` (mặc định), video của bài vừa `PUBLISHED` được tạo phụ đề ngay
trong API:

1. Tải file gốc về thư mục tạm, ffmpeg (`ffmpeg-static`, hoặc `FFMPEG_PATH`) tách âm
   thanh và tìm đoạn im lặng (`silencedetect`, dưới -35 dB, dài từ 0,6 giây).
2. Cắt bỏ im lặng, chỉ gửi phần có tiếng (mono 16 kHz MP3) cho Whisper
   (`TRANSCRIPTION_MODEL`, mặc định `openai/whisper-large-v3` qua OpenRouter
   `/audio/transcriptions`). Video im lặng hoàn toàn không gọi Whisper và nhận
   `NO_SPEECH`, nên Whisper không "bịa" câu cho đoạn im lặng.
3. Mốc thời gian của Whisper được ánh xạ ngược về video gốc, nên phụ đề vẫn khớp hình.
4. `OPENROUTER_MODEL` dịch từng dòng: tiếng Việt sang tiếng Anh, ngôn ngữ khác sang tiếng
   Việt. Dịch lỗi thì vẫn giữ phụ đề gốc.
5. Mỗi ngôn ngữ là một file WebVTT trên Cloudinary (`<folder>/captions/<mediaId>/<lang>.vtt`),
   lưu trong mảng nhúng `media_assets.captions` và trả về ở `media.captions` (ngôn ngữ nói trước).

Trạng thái nằm ở `MediaAsset.captionStatus` (`NONE`, `TRANSCRIBING`, `READY`,
`NO_SPEECH`, `FAILED`); cron 10 phút một lần chạy lại video bị gián đoạn do restart.

## Comment và like bài đăng

Các API tương tác áp dụng cho bài `PUBLISHED`:

- `GET /api/v1/posts/:postId/comments`: comment mới nhất trước, phân trang cursor.
- `POST /api/v1/posts/:postId/comments`: tạo comment, nội dung tối đa 1000 ký tự.
- `PATCH /api/v1/posts/:postId/comments/:commentId`: sửa comment của mình.
- `DELETE /api/v1/posts/:postId/comments/:commentId`: xóa bởi người viết, chủ bài hoặc admin.
- `PUT /api/v1/posts/:postId/like` và `DELETE` cùng URL: like/unlike, gọi lặp an toàn.

API ghi yêu cầu Bearer token. Response bài đăng bổ sung `commentCount`, `likeCount`,
`isLiked`; feed vẫn đọc công khai, gửi token để nhận trạng thái like của người xem.

Mỗi cặp bài/người dùng chỉ có một like và một bookmark (unique index), và xoá bài sẽ
xoá kèm comment/like/bookmark qua `deleteWithReferences`.
Tài liệu FE: [docs/docs-for-FE/post-comments-likes.md](docs/docs-for-FE/post-comments-likes.md).

## Kho công thức và chọn món vào thực đơn

- `GET /api/v1/recipes`: kho công thức công khai, tìm theo `q` (món/nguyên liệu),
  lọc tổng thời gian bằng `maxMinutes`, phân trang `page`/`limit`.
- `suitableForMe=true` cần Bearer token: loại món chứa nguyên liệu/nhóm người dùng
  tránh và món có xung đột nội bộ, trước khi phân trang.
- `GET /api/v1/recipes/:id`: chi tiết nguyên liệu, bước nấu, ảnh và cảnh báo;
  bài nguồn chưa công khai không được trả về.
- `POST /api/v1/meal-plan/preview`: xem trước các ngày được chỉnh, trả vấn đề và
  món cũ/mới, không lưu. Dùng `PUT /api/v1/meal-plan/days` khi người dùng áp dụng;
  lỗi `MEAL_PLAN_INVALID` có thêm `problems` để frontend hiển thị.

Không cần migration mới. API quản lý công thức vẫn thuộc admin. Hợp đồng FE và
ví dụ: [Kho công thức và thực đơn](docs/docs-for-FE/recipe-catalog-meal-plan.md).

## Danh sách mua sắm từ thực đơn

`GET /api/v1/meal-plan/shopping-list?days=MON,TUE` tổng hợp nguyên liệu của thực
đơn riêng, mặc định cả tuần. Cộng theo ingredientId + cùng đơn vị, mỗi lần món
xuất hiện tính đủ định lượng gốc, giữ rõ lượng chưa biết và nguồn món/ngày/bữa.
Không cần migration. [Hợp đồng FE](docs/docs-for-FE/meal-plan-shopping-list.md).
## Công thức yêu thích

`PUT/DELETE /api/v1/recipes/:id/favorite` lưu/bỏ lưu idempotent.
`GET /api/v1/recipes/favorites` trả danh sách riêng, phân trang page/limit.
Catalog và detail có `isFavorite` theo người gọi; response cá nhân dùng private,
no-store. Cần migration `20261019140000_recipe_favorites`.
[Hợp đồng FE](docs/docs-for-FE/recipe-favorites.md).

## Đánh giá công thức

- `GET /api/v1/recipes/:id/ratings/summary`: tổng và điểm trung bình công khai.
- `GET /api/v1/recipes/:id/rating`: điểm của người gọi, cần đăng nhập.
- `PUT /api/v1/recipes/:id/rating` với `{ "value": 4 }`: chấm/cập nhật từ 1–5 sao.
- `DELETE /api/v1/recipes/:id/rating`: gỡ điểm của mình; cả PUT/DELETE idempotent.
- Không tự chấm công thức của mình; điểm trung bình không có dữ liệu thì `null`.

Cần migration `20261019130000_recipe_ratings`. Hợp đồng, quyền và phạm vi hiện tại:
[Đánh giá công thức](docs/docs-for-FE/recipe-ratings.md).

## Blog công thức dài

- `POST /api/v1/blogs`: tạo bài có tiêu đề, ảnh bìa HTTPS, Markdown và công thức
  liên kết; mặc định lưu nháp riêng tư.
- `GET /api/v1/blogs`, `GET /api/v1/blogs/:id`: đọc bài đã xuất bản;
  `GET /api/v1/blogs/mine` cho tác giả quản lý nháp và bài của mình.
- `PATCH /api/v1/blogs/:id`: sửa, xuất bản hoặc chuyển về nháp;
  `DELETE /api/v1/blogs/:id` xóa bài và tương tác.
- Blog dùng cùng ID với Post, hiện trong feed/trang cá nhân và dùng lại
  comment/like/bookmark. `GET /posts?type=BLOG|POST` lọc loại bài;
  field `blog` chứa summary, nội dung đầy đủ đọc qua `/blogs/:id`.

Cần migration `20261012000000_blogs`. Hợp đồng FE và quy tắc Markdown:
[Blog công thức dài](docs/docs-for-FE/blogs.md).

## Phân trang dùng chung

Thành phần tại `src/common/pagination` hỗ trợ hai kiểu phân trang cho GET danh sách:

- `PaginationQueryDto`: `page` mặc định 1, tối đa 1000000; `limit` mặc định 20, tối đa 50.
- `CursorPaginationQueryDto`: `cursor` tùy chọn (UUID v4), cùng quy tắc `limit`.
- `getPaginationArgs(query)`: chuyển page/limit đã validate thành `{ skip, take }` cho Mongoose.
- `createPaginatedResponse(items, totalItems, query)`: trả `{ items, meta }`.
- `createCursorPaginatedResponse(rows, limit)`: nhận tối đa `limit + 1` bản ghi,
  bỏ bản ghi dư và trả `{ items, nextCursor }`.
- `@ApiPaginatedResponse(ItemDto)`: mô tả response page với schema item cụ thể trong Swagger.

Ví dụ GET danh sách người dùng ở controller:

```ts
import { Get, Query } from '@nestjs/common';
import { ApiPaginatedResponse, PaginationQueryDto } from '../common/pagination';

// Bên trong UsersController, giữ guard xác thực của endpoint.
@Get()
@ApiPaginatedResponse(UserResponseDto)
findAll(@Query() query: PaginationQueryDto) {
  return this.usersService.findAll(query);
}
```

Phần truy vấn trong `UsersService.findAll`:

```ts
import { createPaginatedResponse, getPaginationArgs } from '../common/pagination';

const { skip, take } = getPaginationArgs(query);
const [items, totalItems] = await Promise.all([
  this.users
    .find(filter)
    .select(publicUserFields.join(' '))
    .sort({ createdAt: -1, _id: -1 })
    .skip(skip)
    .limit(take)
    .exec(),
  this.users.countDocuments(filter),
]);
return createPaginatedResponse(items.map(toPublicUser), totalItems, query);
```

Để thêm bộ lọc, tạo DTO kế thừa `PaginationQueryDto` hoặc `CursorPaginationQueryDto`
và khai báo validator/Swagger cho từng trường. Với phân trang page, `find` và
`countDocuments` phải dùng cùng filter; sắp xếp luôn có `_id` làm khóa phân định
khi trùng giá trị. Chạy hai truy vấn song song như ví dụ trên.

Với cursor, xem `afterCursor` trong `src/common/pagination/keyset.ts`: filter
`field < value OR (field = value AND _id < cursor id)`, sắp xếp ổn định theo
`{ [field]: -1, _id: -1 }`, lấy `limit + 1` để biết còn trang sau. Dùng
`CursorPaginatedResponseDto<ItemDto>` và khai báo lại schema `items` trong DTO response
cụ thể như `PostPageDto`.

Không cần đăng ký module hoặc interceptor. Tích hợp DTO/helper trực tiếp ở từng GET
danh sách; GET chi tiết giữ response hiện tại. `GET /users` đã chuyển từ mảng trực tiếp
sang `{ items, meta }`, còn `GET /posts` giữ `{ items, nextCursor }`.

Tài liệu tích hợp frontend: [docs/docs-for-FE/pagination.md](docs/docs-for-FE/pagination.md).

## Lệnh phát triển

```bash
npm run start:dev
npm run build
npm run lint
npm test            # unit (Vitest)
npm run test:e2e    # HTTP e2e (Vitest + supertest)
npm run test:db     # test cần MongoDB thật (TEST_DATABASE_URL)
npm run seed        # seed tài khoản admin + danh mục khởi đầu
npm run seed:prod   # chạy seed từ dist (container)
```

Test dùng Vitest + `@nestjs/testing` theo [hướng dẫn của NestJS](https://docs.nestjs.com/fundamentals/testing). Unit test (`src/**/*.spec.ts`) và DB test (`test/**/*.db-spec.ts`) dựng module với `MongoModule.forTest(...)`, trỏ vào một database tạm riêng cho từng file (`test/mongo-test-db.ts`), rồi xoá database đó sau khi chạy. E2E (`test/**/*.e2e-spec.ts`) chạy cả `AppModule` qua HTTP với `configureApp` giống production trên database tạm.

Khi sửa schema, sửa class trong `src/mongo/schemas/`: Mongoose tạo collection và index còn thiếu khi API khởi động (`autoIndex`) và trong test qua `prepareTestDatabase`. MongoDB không có migration, nên không có lịch sử thay đổi để review: kiểm tra kỹ thay đổi schema (đặc biệt index unique và partial filter) trước khi merge.

Một số quy tắc của MongoDB mà code phải tuân theo (chi tiết trong `src/mongo/`):

- Khoá chính là `String` UUID trong `_id`; document trả về có thêm virtual `id` cùng giá trị. Model nối dùng id riêng cộng unique index.
- Không có khoá ngoại: `onDelete` do `deleteWithReferences` áp dụng (`cascade`, `setNull`, `restrict`). Ghi id tham chiếu dạng scalar thì service phải kiểm tra tồn tại trước (`allExist`).
- Field optional mặc định `null`, mảng mặc định `[]`, để document luôn có đủ field mà code đọc.
- Danh sách con nhỏ thuộc hẳn một document (phụ đề) được nhúng vào document cha thay vì tách collection.
- Index unique trên field optional (`googleId`, `activeIntentKey`, `providerTransactionId`) là partial index (`$type: "string"`).
- Transaction mở bằng `MongoService.withTransaction`; mọi truy vấn bên trong phải nhận `.session(session)`. MongoDB không có `SELECT … FOR UPDATE`: transaction cần khoá dùng `lockDocument`, khi xung đột ghi driver tự thử lại callback.
- Không `.lean()` trong service: giữ document để dùng virtual `id`; không spread document, dùng field cụ thể hoặc `.toObject()`.

### Seed production

Container production tự chạy seed mỗi lần khởi động (xem `CMD` trong `Dockerfile`); nếu seed lỗi, API vẫn khởi động. Seed gồm hai phần:

- Tài khoản `vedora.admin` (`src/database/seed.ts`).
- Danh mục khởi đầu từ `seed-data/recipes.json` (`src/database/seed-catalog.ts`): nguyên liệu, nhóm, quy tắc kỵ nhau và công thức kèm đường dẫn ảnh món. Phần này chỉ thêm những gì còn thiếu, so theo tên hoặc tiêu đề: không sửa hay xoá dữ liệu admin đã chỉnh, và chỉ gán ảnh cho công thức chưa có ảnh.

Để chạy lại bằng tay, mở **Terminal** của service `api` trên Dokploy rồi chạy:

```bash
npm run seed:prod
```

Nếu chạy production Compose từ máy chủ bằng CLI:

```bash
docker compose -f docker-compose.dokploy.yml exec api npm run seed:prod
```

Với Compose local, dùng:

```bash
docker compose exec api npm run seed:prod
```

Seed có tính idempotent, vì vậy có thể chạy lại mà không tạo trùng user `vedora.admin`. Khai báo `SEED_USER_PASSWORD` trước khi seed; nếu không có biến này thì seed user sẽ được bỏ qua. Seed không đặt lại mật khẩu của user đã tồn tại, ngoại trừ user cũ được chuyển đổi từ schema trước auth và chưa có mật khẩu. Sau khi sửa nội dung seed, commit và deploy lại image; seed mới sẽ chạy khi container khởi động.

Seed tạo tài khoản với vai trò `ADMIN`, hoặc cấp quyền đó cho tài khoản seed cũ
có username `vedora.admin`, email `admin@vedora.local` và email đã xác minh.
Khi tài khoản cũ còn là `USER`, `SEED_USER_PASSWORD` phải khớp mật khẩu hiện tại
trước khi seed cấp `ADMIN`; chỉ trùng tên và email không đủ để được nâng quyền.
Nếu email seed thuộc tài khoản khác hoặc chưa xác minh, seed dừng với lỗi thay vì
cấp quyền admin. Migration không tự cấp quyền dựa trên username/email.

## Triển khai lên organization Dokploy

Dashboard được cung cấp: <https://dokploy.quanphungg.me/>.

### 1. Vào organization

1. Mở dashboard và đăng nhập bằng đúng email đã nhận lời mời.
2. Chấp nhận invitation nếu màn hình còn hiển thị lời mời.
3. Kiểm tra organization đang chọn ở organization switcher. Nếu không thấy quyền tạo project/service, nhờ owner cấp quyền tương ứng; thành viên không nên tự cài lại Dokploy trên server.

### 2. Đưa code lên GitHub

Remote của repository này là `https://github.com/WDP-FA26/vedora-api.git`. Commit và push code lên nhánh triển khai, thường là `main`:

```bash
git add .
git commit -m "chore: initialize NestJS backend"
git push origin main
```

Không commit `.env`; file này đã được ignore. Chỉ `.env.example` được đưa lên Git.

Nếu repository private, owner/admin Dokploy cần kết nối GitHub App trong phần Git Providers và cấp quyền đọc repository `WDP-FA26/vedora-api`. Phương án khác là tạo SSH key trong Dokploy, thêm public key đó làm deploy key trên GitHub và dùng SSH URL của repository.

### 3. Tạo Compose service

1. Trong organization, chọn **Create Project** (ví dụ `Vedora`).
2. Chọn environment `production` hoặc tạo mới.
3. Chọn **Create Service → Compose**.
4. Compose type: **Docker Compose** (không chọn Docker Stack vì file đang dùng `build`).
5. Source provider: GitHub; chọn repository `WDP-FA26/vedora-api` và branch `main`.
6. Compose path: `./docker-compose.dokploy.yml`.
7. Lưu cấu hình, chưa deploy cho đến khi đã nhập environment variables.

### 4. Khai báo environment variables

Mẫu cơ bản nằm trong `.env.example`. Không tạo hoặc commit file production chứa secret thật. Trong tab **Environment** của Dokploy, nhập các biến sau. Dùng mật khẩu ngẫu nhiên mạnh và không dùng giá trị mẫu:

```dotenv
API_PREFIX=api/v1
CORS_ORIGIN=https://ten-mien-frontend.example.com
JWT_SECRET=THAY_BANG_CHUOI_NGAU_NHIEN_IT_NHAT_32_KY_TU
JWT_ACCESS_TTL=3600
REFRESH_TOKEN_TTL=2592000
GOOGLE_CLIENT_ID=GOOGLE_OAUTH_CLIENT_ID
GOOGLE_CLIENT_SECRET=GOOGLE_OAUTH_CLIENT_SECRET
GOOGLE_CALLBACK_URL=https://ten-mien-frontend.example.com/auth/google
MONGO_DB=vedora
MONGO_USER=vedora
MONGO_PASSWORD=THAY_BANG_MAT_KHAU_NGAU_NHIEN
DATABASE_URL=mongodb://vedora:THAY_BANG_MAT_KHAU_NGAU_NHIEN@mongo:27017/vedora?authSource=admin&replicaSet=rs0
```

`mongo` trong `DATABASE_URL` là tên service nội bộ Docker (cũng là tên host mà replica set `rs0` quảng bá), không đổi thành `localhost`. Nếu mật khẩu có ký tự đặc biệt trong URL (`@`, `:`, `/`, `#`, `%`...), phải URL-encode mật khẩu hoặc dùng chuỗi chỉ gồm chữ và số đủ dài.

File Compose tham chiếu rõ từng biến bằng `${VARIABLE}`; Dokploy sẽ tạo `.env` để Compose nội suy chúng. Không đưa secrets trực tiếp vào Git.

### 5. Deploy và kiểm tra

1. Nhấn **Deploy**.
2. Theo dõi tab **Deployments** cho đến khi build xong.
3. Mở **Logs**, chọn service `api`; cần thấy NestJS start thành công (log tạo index của Mongoose chạy ngay sau khi kết nối).
4. Trong **Monitoring/General**, cả `mongo` và `api` phải ở trạng thái healthy (`mongo` tự khởi tạo replica set ở lần chạy đầu).
5. Nếu lỗi kết nối DB, kiểm tra `DATABASE_URL`, đặc biệt hostname phải là `mongo`, password phải khớp `MONGO_PASSWORD`, và URL phải có `authSource=admin&replicaSet=rs0`.

### 6. Gắn domain và HTTPS

1. Tạo DNS record `A` cho subdomain API, trỏ về IP server Dokploy.
2. Mở Compose service → tab **Domains** → **Add Domain**.
3. Chọn service `api`, container port `3000`, path `/`.
4. Bật HTTPS/Let's Encrypt và lưu.
5. Kiểm tra `https://api.example.com/api/v1/health` và `https://api.example.com/docs`.

Không cần tự thêm Traefik labels; Dokploy Domains sẽ sinh routing cho service. MongoDB không có `ports` trong file Dokploy nên không bị public ra Internet.

### 7. Auto deploy

Với GitHub provider, bật **Auto Deploy** và bảo đảm branch trong Dokploy là `main`. Mỗi lần push đúng branch, Dokploy sẽ pull code và build lại. Nếu dùng generic Git/SSH thay vì GitHub App, lấy webhook URL trong tab Deployments rồi cấu hình webhook push ở GitHub.

### 8. Backup và vận hành

- Dữ liệu MongoDB nằm trong named volume `mongo_data`; keyfile của replica set nằm trong `mongo_config` (đừng xoá, mất keyfile thì không vào lại được dữ liệu). Dữ liệu vẫn còn khi redeploy.
- Cấu hình S3-compatible destination trong Dokploy trước, sau đó tạo lịch backup ở tab **Backups/Volume Backups** của Compose.
- Chạy một lần **Test backup** và thử quy trình restore trước khi coi backup là hoàn tất.
- Theo dõi Logs/Monitoring và đặt giới hạn CPU/RAM trong Advanced khi biết tải thực tế.
- Khi đổi cấu trúc database, Mongoose tạo index còn thiếu lúc khởi động nhưng không sửa document cũ; thay đổi phá vỡ dữ liệu phải xử lý thủ công trước khi deploy.

Tài liệu Dokploy tham khảo:

- [Docker Compose](https://docs.dokploy.com/docs/core/docker-compose)
- [Domains cho Docker Compose](https://docs.dokploy.com/docs/core/docker-compose/domains)
- [Git providers](https://docs.dokploy.com/docs/core/providers)
- [Auto Deploy](https://docs.dokploy.com/docs/core/auto-deploy)
- [Database backups](https://docs.dokploy.com/docs/core/databases/backups)

## Biến môi trường

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
| --- | --- | --- | --- |
| `DATABASE_URL` | Có | — | MongoDB connection string của replica set. Chạy API trên host thì thêm `directConnection=true` |
| `NODE_ENV` | Không | `development` | Môi trường chạy |
| `PORT` | Không | `3000` | Port của NestJS |
| `API_PREFIX` | Không | `api/v1` | Global API prefix |
| `CORS_ORIGIN` | Không | `*` | Một hoặc nhiều origin, phân tách bằng dấu phẩy |
| `JWT_SECRET` | Có | — | Secret ký và xác thực access token, tối thiểu 32 ký tự |
| `JWT_ACCESS_TTL` | Không | `3600` | Thời hạn access token, tính bằng giây |
| `REFRESH_TOKEN_TTL` | Không | `2592000` | Thời hạn refresh token, tính bằng giây |
| `GOOGLE_CLIENT_ID` | Khi dùng Google login | — | OAuth 2.0 Client ID của Google |
| `GOOGLE_CLIENT_SECRET` | Khi dùng Google login | — | OAuth 2.0 Client Secret của Google |
| `GOOGLE_CALLBACK_URL` | Khi dùng Google login | URL callback local | Redirect URI phải khớp Google Cloud Console |
| `CLOUDINARY_CLOUD_NAME` | Khi upload video | — | Cloud name; trống thì route media trả `503` |
| `CLOUDINARY_API_KEY` | Khi upload video | — | API key dùng để ký upload |
| `CLOUDINARY_API_SECRET` | Khi upload video | — | API secret; cũng dùng để kiểm chữ ký webhook |
| `CLOUDINARY_FOLDER` | Không | `vedora` | Thư mục gốc của video và phụ đề |
| `CLOUDINARY_WEBHOOKS_ENABLED` | Production | `false` | `true` khi Console đã trỏ webhook Upload/Eager về API; `false` thì tự hỏi Admin API khi đọc |
| `CAPTIONS_ENABLED` | Không | `true` | Ghi lời (Whisper) và dịch phụ đề cho video đã đăng |
| `TRANSCRIPTION_MODEL` | Không | `openai/whisper-large-v3` | Model ghi lời trên OpenRouter |
| `FFMPEG_PATH` | Không | ffmpeg của `ffmpeg-static` | ffmpeg dùng để tách âm thanh; image Docker dùng `/usr/bin/ffmpeg` |
| `FRONTEND_URL` | Không | `http://localhost:3000` | Origin của frontend |
| `MAX_VIDEO_DURATION_SEC` | Không | `180` | Video dài hơn bị đánh dấu `FAILED` và xoá khỏi Cloudinary |
| `SEED_USER_PASSWORD` | Khi muốn seed user | — | Mật khẩu ban đầu cho `vedora.admin` |
| `MONGO_DB` | Khi dùng Compose | — | Database được container MongoDB tạo |
| `MONGO_USER` | Khi dùng Compose | — | Tài khoản root MongoDB |
| `MONGO_PASSWORD` | Khi dùng Compose | — | Mật khẩu root MongoDB |

## Checklist trước production

- Đổi toàn bộ credentials mẫu.
- Đặt `CORS_ORIGIN` đúng domain frontend, không dùng `*` nếu frontend gửi cookie.
- Gắn domain HTTPS và kiểm tra `/api/v1/health/ready`.
- Bật backup định kỳ và kiểm thử restore.
- Bảo vệ hoặc tắt Swagger nếu API không muốn public tài liệu.
- Dùng `JWT_SECRET` ngẫu nhiên, đủ dài và khác nhau giữa các môi trường.
- Đăng ký chính xác production `GOOGLE_CALLBACK_URL` trong Google Cloud Console.
- Bổ sung authorization theo nghiệp vụ trước khi đưa endpoint nhạy cảm ra Internet.
