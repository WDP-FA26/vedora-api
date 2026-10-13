# Vedora API

Backend starter cho Vedora, sử dụng NestJS, Prisma ORM, PostgreSQL và Docker. Repository có sẵn cấu hình để chạy local hoặc triển khai bằng Docker Compose trên Dokploy.

## Thành phần

- NestJS 11 + TypeScript
- Prisma ORM + PostgreSQL 17
- Swagger/OpenAPI tại `/docs`
- Validation request, CORS và security headers
- Health check tách liveness/readiness
- Migration tự chạy trước khi container API khởi động
- Docker image multi-stage, chạy bằng non-root user
- Docker Compose cho local và Dokploy

## Cấu trúc chính

```text
.
├── prisma/
│   ├── migrations/            # Lịch sử migration cần commit
│   ├── schema.prisma
│   └── seed.ts
├── src/
│   ├── common/pagination/     # DTO, helper và Swagger cho phân trang dùng chung
│   ├── health/                # Liveness/readiness
│   ├── media/                 # Upload video lên Mux, webhook, dọn dẹp định kỳ
│   ├── mux/                   # Mux client dùng chung
│   ├── posts/                 # Bài ngắn, blog, comment, like và bookmark
│   ├── prisma/                # PrismaService dùng chung
│   ├── users/                 # CRUD mẫu
│   ├── app.module.ts
│   └── main.ts
├── Dockerfile
├── docker-compose.yml         # Chạy local
└── docker-compose.dokploy.yml # Deploy trên Dokploy
```

## Chạy local không dùng Docker cho API

Yêu cầu Node.js `>=20.11`, npm và PostgreSQL.

```bash
cp .env.example .env
npm install
npm run prisma:migrate:dev
npm run prisma:seed
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

Không thêm `-v` nếu muốn giữ dữ liệu PostgreSQL. `docker compose down -v` sẽ xóa volume database.

## API mẫu

| Method | Endpoint | Mô tả |
| --- | --- | --- |
| `GET` | `/api/v1` | Thông tin API |
| `GET` | `/api/v1/health` | Liveness |
| `GET` | `/api/v1/health/ready` | Readiness + PostgreSQL |
| `POST` | `/api/v1/auth/register` | Đăng ký và gửi mã xác minh email; chưa trả token |
| `POST` | `/api/v1/auth/login` | Đăng nhập bằng username/password và nhận cặp AT/RT |
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

### Bài đăng có video (Mux)

File video đi thẳng từ trình duyệt lên Mux, không qua API:

1. `POST /api/v1/media/uploads` với `{"type":"VIDEO"}` trả về `media.id` và `uploadUrl`
   (Mux direct upload, hết hạn sau 1 giờ, chỉ nhận từ origin `FRONTEND_URL`).
2. Trình duyệt `PUT` file lên `uploadUrl` (nên dùng `@mux/upchunk` để có tiến trình).
3. `POST /api/v1/posts` với `{"type":"POST","body":"…","mediaIds":["<media.id>"]}` được
   gọi ngay, không cần đợi Mux xử lý xong. Bài ở trạng thái `PROCESSING` (chỉ tác giả
   thấy) rồi chuyển sang `PUBLISHED` khi video sẵn sàng, hoặc `FAILED` (ví dụ video dài
   hơn `MAX_VIDEO_DURATION_SEC`).
4. Frontend poll `GET /api/v1/posts/:id` tới khi hết `PROCESSING`, rồi phát video bằng
   `playbackId` (`https://stream.mux.com/<playbackId>.m3u8`).

Mux báo tiến trình qua webhook `POST /api/v1/webhooks/mux`. Ở production, tạo webhook
trỏ tới URL đó trong Mux dashboard và điền signing secret vào `MUX_WEBHOOK_SECRET`. Khi
để trống (local, Mux không gọi được `localhost`), API tự hỏi Mux mỗi lần media/bài đang
chờ được đọc. Một cron 10 phút một lần cũng cập nhật media bị lỡ webhook, và cron hằng
giờ xoá upload không được gắn vào bài nào sau 24 giờ.

Khi `MUX_CAPTIONS_ENABLED=true`, video của bài vừa `PUBLISHED` được tạo phụ đề bằng Mux
Robots: `generate-premium-captions` tự nhận diện ngôn ngữ nói, API gắn track phụ đề
(tên theo ngôn ngữ đó, ví dụ "Tiếng Việt") rồi `translate-captions` dịch tiếng Việt sang
tiếng Anh, ngôn ngữ khác sang tiếng Việt. Video không có lời (độ tin cậy nhận diện
ngôn ngữ thấp, hoặc chỉ có `[beep]`, `[music]`) không được gắn phụ đề. Trạng thái nằm
ở `MediaAsset.captionStatus`; các bước tiếp theo chạy theo webhook `robots.job.*` và
`video.asset.track.ready`, cron 10 phút một lần chạy lại bước bị lỡ webhook.
MuxPlayer tự hiện các track trong menu CC nên frontend không cần đổi gì.

## Comment và like bài đăng

Các API tương tác áp dụng cho bài `PUBLISHED`:

- `GET /api/v1/posts/:postId/comments`: comment mới nhất trước, phân trang cursor.
- `POST /api/v1/posts/:postId/comments`: tạo comment, nội dung tối đa 1000 ký tự.
- `PATCH /api/v1/posts/:postId/comments/:commentId`: sửa comment của mình.
- `DELETE /api/v1/posts/:postId/comments/:commentId`: xóa bởi người viết, chủ bài hoặc admin.
- `PUT /api/v1/posts/:postId/like` và `DELETE` cùng URL: like/unlike, gọi lặp an toàn.

API ghi yêu cầu Bearer token. Response bài đăng bổ sung `commentCount`, `likeCount`,
`isLiked`; feed vẫn đọc công khai, gửi token để nhận trạng thái like của người xem.

Migration `20261002000000_post_comments_and_likes` tạo hai bảng, unique key chống like
trùng và khóa ngoại cascade. Chạy `npm run prisma:migrate:deploy` trước khi dùng bản mới.
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
- `getPaginationArgs(query)`: chuyển page/limit đã validate thành `{ skip, take }` cho Prisma.
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
import { Prisma } from '@prisma/client';
import { createPaginatedResponse, getPaginationArgs } from '../common/pagination';

const [items, totalItems] = await this.prisma.$transaction(
  [
    this.prisma.user.findMany({
      select: publicUserSelect,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...getPaginationArgs(query),
    }),
    this.prisma.user.count(),
  ],
  { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
);
return createPaginatedResponse(items, totalItems, query);
```

Để thêm bộ lọc, tạo DTO kế thừa `PaginationQueryDto` hoặc `CursorPaginationQueryDto`
và khai báo validator/Swagger cho từng trường. Với phân trang page, `findMany` và
`count` phải dùng cùng điều kiện `where`; sắp xếp luôn có khóa duy nhất để phân định
khi trùng giá trị (ví dụ `id`). Transaction `RepeatableRead` giúp số lượng và danh sách
nhất quán trong một response.

Với cursor, xem `PostsService.list`: lấy `limit + 1` item, sắp xếp ổn định,
truyền `cursor: { id }` cùng `skip: 1` khi có cursor. Dùng
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
npm run prisma:generate
npm run prisma:migrate:dev -- --name ten_migration
npm run prisma:migrate:deploy
npm run prisma:studio
npm run prisma:seed
npm run prisma:seed:prod
```

Test dùng Vitest + `@nestjs/testing` theo [hướng dẫn của NestJS](https://docs.nestjs.com/fundamentals/testing): unit test (`src/**/*.spec.ts`) dựng service bằng `Test.createTestingModule` với mock `vitest-mock-extended`; e2e (`test/**/*.e2e-spec.ts`) chạy cả `AppModule` qua HTTP với `configureApp` giống production, chỉ Prisma bị mock.

Khi sửa `prisma/schema.prisma`, tạo migration bằng `prisma:migrate:dev`, kiểm tra SQL trong `prisma/migrations`, rồi commit cả schema và migration. Container production chạy `prisma migrate deploy` tự động trước khi start NestJS. Migration cần giữ advisory lock theo phiên, nên nếu `DATABASE_URL` trỏ tới pooler ở chế độ transaction (PgBouncer, host `-pooler` của Neon) thì lệnh này lỗi `P1002`; khi đó khai báo thêm `DIRECT_URL` là kết nối trực tiếp.

### Seed production

Container production tự chạy seed mỗi lần khởi động, ngay sau `prisma migrate deploy` (xem `CMD` trong `Dockerfile`); nếu seed lỗi, API vẫn khởi động. Seed gồm hai phần:

- Tài khoản `vedora.admin` (`src/database/seed.ts`).
- Danh mục khởi đầu từ `prisma/seed-data/recipes.json` (`src/database/seed-catalog.ts`): nguyên liệu, nhóm, quy tắc kỵ nhau và công thức kèm đường dẫn ảnh món. Phần này chỉ thêm những gì còn thiếu, so theo tên hoặc tiêu đề: không sửa hay xoá dữ liệu admin đã chỉnh, và chỉ gán ảnh cho công thức chưa có ảnh.

Để chạy lại bằng tay, mở **Terminal** của service `api` trên Dokploy rồi chạy:

```bash
npm run prisma:seed:prod
```

Nếu chạy production Compose từ máy chủ bằng CLI:

```bash
docker compose -f docker-compose.dokploy.yml exec api npm run prisma:seed:prod
```

Với Compose local, dùng:

```bash
docker compose exec api npm run prisma:seed:prod
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
POSTGRES_DB=vedora
POSTGRES_USER=vedora
POSTGRES_PASSWORD=THAY_BANG_MAT_KHAU_NGAU_NHIEN
DATABASE_URL=postgresql://vedora:THAY_BANG_MAT_KHAU_NGAU_NHIEN@postgres:5432/vedora?schema=public
```

`postgres` trong `DATABASE_URL` là tên service nội bộ Docker, không đổi thành `localhost`. Nếu mật khẩu có ký tự đặc biệt trong URL (`@`, `:`, `/`, `#`, `%`...), phải URL-encode mật khẩu hoặc dùng chuỗi chỉ gồm chữ và số đủ dài.

File Compose tham chiếu rõ từng biến bằng `${VARIABLE}`; Dokploy sẽ tạo `.env` để Compose nội suy chúng. Không đưa secrets trực tiếp vào Git.

### 5. Deploy và kiểm tra

1. Nhấn **Deploy**.
2. Theo dõi tab **Deployments** cho đến khi build xong.
3. Mở **Logs**, chọn service `api`; cần thấy NestJS start thành công và không còn lỗi migration.
4. Trong **Monitoring/General**, cả `postgres` và `api` phải ở trạng thái healthy.
5. Nếu lỗi kết nối DB, kiểm tra `DATABASE_URL`, đặc biệt hostname phải là `postgres` và password phải khớp `POSTGRES_PASSWORD`.

### 6. Gắn domain và HTTPS

1. Tạo DNS record `A` cho subdomain API, trỏ về IP server Dokploy.
2. Mở Compose service → tab **Domains** → **Add Domain**.
3. Chọn service `api`, container port `3000`, path `/`.
4. Bật HTTPS/Let's Encrypt và lưu.
5. Kiểm tra `https://api.example.com/api/v1/health` và `https://api.example.com/docs`.

Không cần tự thêm Traefik labels; Dokploy Domains sẽ sinh routing cho service. PostgreSQL không có `ports` trong file Dokploy nên không bị public ra Internet.

### 7. Auto deploy

Với GitHub provider, bật **Auto Deploy** và bảo đảm branch trong Dokploy là `main`. Mỗi lần push đúng branch, Dokploy sẽ pull code và build lại. Nếu dùng generic Git/SSH thay vì GitHub App, lấy webhook URL trong tab Deployments rồi cấu hình webhook push ở GitHub.

### 8. Backup và vận hành

- Volume PostgreSQL là named volume `postgres_data`, dữ liệu vẫn còn khi redeploy.
- Cấu hình S3-compatible destination trong Dokploy trước, sau đó tạo lịch backup ở tab **Backups/Volume Backups** của Compose.
- Chạy một lần **Test backup** và thử quy trình restore trước khi coi backup là hoàn tất.
- Theo dõi Logs/Monitoring và đặt giới hạn CPU/RAM trong Advanced khi biết tải thực tế.
- Khi đổi cấu trúc database, chỉ dùng migration đã commit; không chạy `prisma migrate dev` trên production.

Tài liệu Dokploy tham khảo:

- [Docker Compose](https://docs.dokploy.com/docs/core/docker-compose)
- [Domains cho Docker Compose](https://docs.dokploy.com/docs/core/docker-compose/domains)
- [Git providers](https://docs.dokploy.com/docs/core/providers)
- [Auto Deploy](https://docs.dokploy.com/docs/core/auto-deploy)
- [Database backups](https://docs.dokploy.com/docs/core/databases/backups)

## Biến môi trường

| Biến | Bắt buộc | Mặc định | Ý nghĩa |
| --- | --- | --- | --- |
| `DATABASE_URL` | Có | — | PostgreSQL connection string |
| `DIRECT_URL` | Khi `DATABASE_URL` đi qua pooler | — | Kết nối trực tiếp tới PostgreSQL, chỉ dùng cho `prisma migrate deploy` lúc container khởi động. Với Neon: cùng chuỗi kết nối nhưng host không có `-pooler` |
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
| `MUX_TOKEN_ID` | Khi upload video | — | Mux access token ID; trống thì route media trả `503` |
| `MUX_TOKEN_SECRET` | Khi upload video | — | Mux access token secret |
| `MUX_WEBHOOK_SECRET` | Production | — | Signing secret của webhook Mux; trống thì tự hỏi Mux khi đọc |
| `MUX_CAPTIONS_ENABLED` | Không | `false` | Tạo và dịch phụ đề cho video đã đăng (Mux Robots, tính phí theo phút) |
| `FRONTEND_URL` | Không | `http://localhost:3000` | Origin được phép upload video lên Mux |
| `MAX_VIDEO_DURATION_SEC` | Không | `180` | Video dài hơn bị đánh dấu `FAILED` và xoá khỏi Mux |
| `SEED_USER_PASSWORD` | Khi muốn seed user | — | Mật khẩu ban đầu cho `vedora.admin` |
| `POSTGRES_DB` | Khi dùng Compose | — | Database được container PostgreSQL tạo |
| `POSTGRES_USER` | Khi dùng Compose | — | Database user |
| `POSTGRES_PASSWORD` | Khi dùng Compose | — | Database password |

## Checklist trước production

- Đổi toàn bộ credentials mẫu.
- Đặt `CORS_ORIGIN` đúng domain frontend, không dùng `*` nếu frontend gửi cookie.
- Gắn domain HTTPS và kiểm tra `/api/v1/health/ready`.
- Bật backup định kỳ và kiểm thử restore.
- Bảo vệ hoặc tắt Swagger nếu API không muốn public tài liệu.
- Dùng `JWT_SECRET` ngẫu nhiên, đủ dài và khác nhau giữa các môi trường.
- Đăng ký chính xác production `GOOGLE_CALLBACK_URL` trong Google Cloud Console.
- Bổ sung authorization theo nghiệp vụ trước khi đưa endpoint nhạy cảm ra Internet.
