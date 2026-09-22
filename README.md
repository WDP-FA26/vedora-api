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
│   ├── health/                # Liveness/readiness
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
| `POST` | `/api/v1/users` | Tạo user |
| `GET` | `/api/v1/users` | Danh sách user |
| `GET` | `/api/v1/users/:id` | Chi tiết user |
| `PATCH` | `/api/v1/users/:id` | Cập nhật user |
| `DELETE` | `/api/v1/users/:id` | Xóa user |

Ví dụ:

```bash
curl -X POST http://localhost:3000/api/v1/users \
  -H "Content-Type: application/json" \
  -d '{"email":"hello@vedora.vn","name":"Vedora User"}'
```

## Lệnh phát triển

```bash
npm run start:dev
npm run build
npm run lint
npm test
npm run prisma:generate
npm run prisma:migrate:dev -- --name ten_migration
npm run prisma:migrate:deploy
npm run prisma:studio
npm run prisma:seed
```

Khi sửa `prisma/schema.prisma`, tạo migration bằng `prisma:migrate:dev`, kiểm tra SQL trong `prisma/migrations`, rồi commit cả schema và migration. Container production chạy `prisma migrate deploy` tự động trước khi start NestJS.

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

Trong tab **Environment**, nhập các biến sau. Dùng mật khẩu ngẫu nhiên mạnh và không dùng giá trị mẫu:

```dotenv
API_PREFIX=api/v1
CORS_ORIGIN=https://ten-mien-frontend.example.com
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
| `NODE_ENV` | Không | `development` | Môi trường chạy |
| `PORT` | Không | `3000` | Port của NestJS |
| `API_PREFIX` | Không | `api/v1` | Global API prefix |
| `CORS_ORIGIN` | Không | `*` | Một hoặc nhiều origin, phân tách bằng dấu phẩy |
| `POSTGRES_DB` | Khi dùng Compose | — | Database được container PostgreSQL tạo |
| `POSTGRES_USER` | Khi dùng Compose | — | Database user |
| `POSTGRES_PASSWORD` | Khi dùng Compose | — | Database password |

## Checklist trước production

- Đổi toàn bộ credentials mẫu.
- Đặt `CORS_ORIGIN` đúng domain frontend, không dùng `*` nếu frontend gửi cookie.
- Gắn domain HTTPS và kiểm tra `/api/v1/health/ready`.
- Bật backup định kỳ và kiểm thử restore.
- Bảo vệ hoặc tắt Swagger nếu API không muốn public tài liệu.
- Bổ sung authentication/authorization trước khi đưa CRUD nghiệp vụ thật ra Internet.
