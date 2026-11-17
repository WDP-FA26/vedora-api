# Báo cáo tiến độ viết Test TDD và Độ phủ (Test Coverage) — Vedora API

**Ngày cập nhật:** 2026-11-17  
**Phạm vi:** `vedora-api` (`src/**/*.ts`, bộ unit test `test/unit/**/*.spec.ts`, dựa trên toàn bộ tài liệu nghiệp vụ tại `docs/docs-for-FE/`, `README.md`, `PRODUCT.md`, `docs/api-bug-hunt-report-2026-11-17.md`, và mã nguồn thực tế). Lưu ý: `vedora-frontend` hiện không có test runner nên phạm vi kiểm thử tự động nằm ở `vedora-api`.

---

## 1. Tổng quan tiến độ & Chỉ số Coverage

### So sánh trước và sau khi bổ sung test TDD

| Chỉ số | Trước (64 file, 556 tests) | Sau (155 file, 1.198 tests) | Mức tăng |
|---|---:|---:|---:|
| **Lines** | 56,01% (2.978 / 5.316) | **98,77%** (5.251 / 5.316) | +42,76% |
| **Statements** | 55,26% (3.180 / 5.754) | **98,19%** (5.650 / 5.754) | +42,93% |
| **Functions** | 47,65% (723 / 1.517) | **98,81%** (1.499 / 1.517) | +51,16% |
| **Branches** | 44,94% (1.298 / 2.888) | **93,62%** (2.704 / 2.888) | +48,68% |
| **Số file `< 80%` (bất kỳ metric nào)** | 147 / 311 | **0 / 311** | Đạt 100% |

- **Tổng số file trong `src/**/*.ts`:** 311 file (gồm **239 file có mã thực thi** và 72 file thuần khai báo kiểu/decorator không sinh câu lệnh thực thi qua SWC).
- **Mức thấp nhất trên toàn bộ 239 file có mã thực thi:**
  - Lines thấp nhất: `src/database/seed-catalog.ts` — **90,38%**
  - Branches thấp nhất: `src/common/ffmpeg/ffmpeg.ts` — **80,00%**
  - **Không có file nào dưới 80%** trên cả 4 chỉ số (Lines, Statements, Functions, Branches).

### Trạng thái chạy kiểm thử & chất lượng mã nguồn

- **`npm run lint`** (`eslint "{src,test}/**/*.ts"`): **PASS** (0 lỗi, 0 cảnh báo).
- **`npm run build`** (`nest build`): **PASS** (0 lỗi).
- **`npx vitest run --coverage --coverage.reporter=text --coverage.reporter=json-summary`** (chạy ngoài sandbox vì unit test DB kết nối MongoDB replica set cục bộ `127.0.0.1:27017`):
  - **149 / 155 file test PASS** (**1.187 / 1.198 tests PASS**).
  - **6 file test FAIL (11 tests)** — toàn bộ 11 test đỏ là **test TDD cố ý giữ đỏ để phơi bày bug thật trong `src/`** (không chỉnh sửa `src/`), gồm 8 test có sẵn từ `commit 4b5e6574` và 3 test TDD mới/tách riêng trong phiên này (chi tiết ở Mục 4).
- Cấu hình [`vitest.config.mts`](../vitest.config.mts): bổ sung `reportOnFailure: true` trong `coverage` để lệnh `npm run test:cov` vẫn xuất báo cáo coverage đầy đủ ngay cả khi các test lộ bug `// BUG-*` đang đỏ.

---

## 2. Độ phủ chi tiết theo từng phân hệ nghiệp vụ

Số liệu tổng hợp từ `coverage/coverage-summary.json` (tính trên các file có mã thực thi trong từng thư mục):

| Phân hệ (`src/...`) | Số file thực thi | Lines % | Statements % | Functions % | Branches % | Trạng thái |
|---|---:|---:|---:|---:|---:|---|
| `src/admin-ai-costs` | 3 | 96,88% | 97,06% | 100,00% | 89,80% | Đạt (>80%) |
| `src/admin-dashboard` | 4 | 100,00% | 100,00% | 100,00% | 96,30% | Đạt (>80%) |
| `src/ai` | 13 | 97,72% | 97,03% | 97,87% | 96,09% | Đạt (>80%) |
| `src/app.controller.ts` | 1 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/app.setup.ts` | 1 | 100,00% | 100,00% | 100,00% | 90,00% | Đạt (>80%) |
| `src/auth` | 7 | 96,70% | 95,85% | 98,33% | 91,24% | Đạt (>80%) |
| `src/auth-core` | 9 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/captcha` | 1 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/cloudinary` | 1 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/common` | 25 | 100,00% | 100,00% | 96,97% | 93,55% | Đạt (>80%) |
| `src/config` | 1 | 100,00% | 100,00% | 100,00% | 95,00% | Đạt (>80%) |
| `src/database` | 3 | 93,67% | 91,67% | 88,89% | 88,64% | Đạt (>80%) |
| `src/health` | 1 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/knowledge` | 10 | 97,28% | 97,22% | 98,10% | 94,03% | Đạt (>80%) |
| `src/mail` | 2 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/main.ts` | 1 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/meal-plan` | 11 | 99,60% | 99,64% | 99,07% | 93,00% | Đạt (>80%) |
| `src/media` | 10 | 100,00% | 99,02% | 100,00% | 93,91% | Đạt (>80%) |
| `src/messaging` | 4 | 99,11% | 97,54% | 97,06% | 91,47% | Đạt (>80%) |
| `src/moderation` | 8 | 98,15% | 98,29% | 100,00% | 92,16% | Đạt (>80%) |
| `src/mongo` | 27 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/notifications` | 2 | 100,00% | 97,44% | 96,67% | 86,00% | Đạt (>80%) |
| `src/nutrition-chat` | 9 | 100,00% | 100,00% | 100,00% | 97,87% | Đạt (>80%) |
| `src/payments` | 12 | 98,23% | 96,74% | 96,94% | 91,60% | Đạt (>80%) |
| `src/posts` | 33 | 99,06% | 98,07% | 99,19% | 93,06% | Đạt (>80%) |
| `src/profiles` | 5 | 99,21% | 98,94% | 98,63% | 93,58% | Đạt (>80%) |
| `src/qdrant` | 1 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/recipes` | 18 | 98,72% | 98,83% | 98,96% | 92,83% | Đạt (>80%) |
| `src/storage` | 1 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/subscriptions` | 4 | 98,11% | 98,23% | 100,00% | 100,00% | Đạt (>80%) |
| `src/swagger.setup.ts` | 1 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |
| `src/users` | 5 | 99,21% | 99,23% | 100,00% | 98,70% | Đạt (>80%) |
| `src/verification` | 3 | 96,49% | 95,00% | 100,00% | 86,96% | Đạt (>80%) |
| `src/webhooks` | 2 | 100,00% | 100,00% | 100,00% | 100,00% | Đạt (>80%) |

---

## 3. Các luồng nghiệp vụ đã đọc & Test case đã viết / mở rộng

Tổng cộng đã tạo mới **91 file test** và mở rộng **19 file test** hiện có (tăng thêm **642 test case** so với 556 test ban đầu):

1. **Hạ tầng chung, Auth Core, Config, Mail, Health, Mongo, Seed (`test/unit/auth-core/`, `common/`, `mail/`, `health/`, `mongo/`, `config/`, `database/`, `app-setup.spec.ts`, `entrypoints.spec.ts`):**
   - `JwtAuthGuard`, `OptionalJwtAuthGuard`, `RolesGuard`, `@Roles()`, `UserThrottlerGuard`, `extractBearerToken`, `hashPassword` (giới hạn 72 UTF-8 bytes bcrypt), `AuthCoreModule`.
   - `AppExceptionFilter` & `toErrorBody` (chuẩn `{ statusCode, code, message, details? }`, chặn ghi sau `headersSent`), `validatePayload` / `parsePayload`, `PaginationLimitDto` / `PaginationQueryDto` / `@ApiPaginatedResponse`, `escapeRegExp`, `fetchPublicImage` (chống SSRF qua IP private/DNS/timeout/giới hạn 10 MiB), `runFfmpeg`, `MailService` / `MailModule`, `HealthController` (`/health`, `/health/ready`), `configureApp` (CORS, prefix, `VALIDATION_FAILED` lồng nhau), `setupSwagger`, `MongoModule.forRoot`, `MongoService.ping`, `lockDocument`, `allExist`, `withUserLocks` (retry `E11000` tối đa 5 lần), `validateEnvironment`, `seedDatabase`, và entrypoint `main.ts` / `seed-cli.ts`.

2. **Auth, Users, Profiles, Verification (`test/unit/auth/`, `users/`, `profiles/`, `verification/`):**
   - `AuthController` (11 route, Turnstile CAPTCHA, Google OAuth PKCE), `RefreshTokensService` (issue, rotation, phát hiện reuse & thu hồi cả family, lock account trong transaction, race đồng thời).
   - `UsersController`, `UsersService` (CRUD, tìm kiếm escaped `q`, filter `status`, optimistic lock `expectedVersion`, bảo vệ ADMIN ACTIVE cuối cùng kể cả khi cạnh tranh đồng thời và bỏ qua admin `SUSPENDED`, ghi `UserAccountAudit` cùng transaction), `AccountsService` (tạo tài khoản, takeover tài khoản chưa xác minh khi Google login, xóa tài khoản stale), `rethrowUniqueViolation`.
   - `ProfilesController`, `ProfilesService` (`updateMe`, `follow`/`unfollow`, `following`/`followers` cursor, upload/activate/clear avatar/cover qua RustFS, dọn ảnh cũ), `FollowSuggestionsService` (`FOLLOWS_YOU`, `MUTUAL`, `ACTIVE` backfill, read-time filter, cache 10 phút, dismiss), và toàn bộ DTO (`profile.dto.ts`, `follow-suggestion.dto.ts`).
   - `VerificationController` và `verification.dto.ts` (min/max statement, 1–6 unique UUIDv4 `proofIds`, `@ValidateIf` bắt buộc `note` khi `REJECTED`).

3. **Payments, Subscriptions, Admin Payments (`test/unit/payments/`, `subscriptions/`):**
   - `payment-code.ts` (mã ngắn 6 ký tự base-36 giữ số 0 đầu), `SepayWebhookGuard`, `PaymentsController`, `SePayWebhookController`, `PaymentReconciliationController`.
   - `PaymentsService` (catalog snapshot, idempotency conflict, orphaned `PaymentRequest`, `PENDING_PAYMENT_CONFLICT`, thử lại tối đa 5 lần khi trùng mã ngắn, hủy đơn, và toàn bộ 11+ outcome của `bankWebhook` trong transaction khóa theo provider tx & payer).
   - `AdminPaymentsController`, `AdminPaymentsService`, `admin-payment-mapping.ts`, `admin-payment-query.dto.ts` (lọc `createdAt` vs `capturedAt`, mapping legacy v1 PRO/PREMIUM sang v2 PLUS/PRO, tổng BigInt/Decimal128, `membershipSnapshot`, export CSV UTF-8 BOM + escape công thức + chặn >10.000 dòng).
   - `SubscriptionsService`, `subscription-policy.ts`, `AiUsageService` (quota dùng chung FREE/PLUS/PRO, giữ chỗ theo lease 10 phút, commit, refund theo ticket, continuation tối đa 8 lượt, idempotency & race).

4. **Posts, Blogs, Interactions, Admin Posts/Reports, Search (`test/unit/posts/`):**
   - `PostsController`, `PostsService` (tạo/sửa/xóa bài ngắn & video, thay đổi `mediaIds`, giữ nguyên `publishedAt`, `POST_NOT_EDITABLE` khi `PROCESSING`), `PostsQueryService` (list, search, feed, bookmarks, following, visibility `PROCESSING`/`PENDING_REVIEW`/`REJECTED`/`FAILED`, polling refresh khi tắt webhook), `PostRelationsService`.
   - `PostInteractionsController`, `PostInteractionsService` (comment CRUD + kiểm duyệt đồng bộ, like/repost/bookmark idempotent, unbookmark bài chưa public).
   - `AdminPostsController`, `AdminReportsController`, `AdminPostsService` (`moderate` `APPROVE`/`REJECT` trên `PENDING_REVIEW`/`REJECTED`).
   - `BlogsController`, `BlogAiController`, `BlogsService` (nháp/xuất bản, `BLOG_CONTENT_REQUIRED`, liên kết công thức), `BlogAssistantService` / tools / prompt (quota, hoàn vé khi moderation lỗi, `searchKnowledge`, `generateImage`/`editImage`, parse messages).
   - `PostSearchIndexService`, `PostSearchService`, và toàn bộ DTO trong `src/posts/dto/` (bao gồm đếm tối đa 250 từ `countWords`/`MaxWords`).

5. **Media, Captions, Cloudinary, Storage, Moderation (`test/unit/media/`, `cloudinary/`, `storage/`, `moderation/`):**
   - `MediaController`, `MediaService`, `MediaMaintenanceService`, `CloudinaryWebhookController`, `@RawBody()`, `CloudinaryService` (chữ ký SHA-1/SHA-256, `findVideo`, `deleteMedia`, `uploadCaption`).
   - `CaptionService`, `speech-audio.ts` (tách âm thanh, `silencedetect`, cắt im lặng 2 pass, map timestamp ngược về video gốc), `TranscriptionService` (word/segment/text fallback, lọc hallucination, dịch vi↔en, tách cue dài).
   - `PostModerationService` (chấm đồng bộ/bất đồng bộ bài viết, video 4 frame + transcript, blog + tối đa 5 ảnh inline, xử lý `provider_blocked`).
   - `StorageService` (presign upload/download, `exists`, `getBytes`, `putBytes`, `delete`, `keyFromPublicUrl` chặn path traversal, `parseEvent`), `AdminModerationController`, `ModerationModule`, `moderation-settings.dto.ts`.

6. **Recipes, Dietary, Meal Plan, Shopping List, Nutrition Chat (`test/unit/recipes/`, `meal-plan/`, `nutrition-chat/`):**
   - 5 controllers (`RecipesController`, `AdminRecipesController`, `AdminIngredientsController` / groups / rules, `DietaryController`, `RecipeRatingsController`) & toàn bộ DTO (`dietary.dto.ts`, `ingredient.dto.ts`, `recipe-catalog.dto.ts`, `recipe.dto.ts`).
   - `RecipesService`, `IngredientsService`, `RecipeRelationsService`, `RecipeCatalogService` (lọc `q`, `maxMinutes`, `suitableForMe`, pagination), `DietaryService`, `IncompatibilityRulesService`, `RecipeFavoritesService`, `RecipeRatingsService` (chặn tự chấm điểm, chỉ tính user đã xác minh email).
   - `MealPlanController`, `ShoppingListController`, `MealPlanService` (xem trước, lưu cả ngày trong transaction, kiểm tra nguyên liệu tránh & xung đột cả ngày), `ShoppingListService` (tổng hợp Decimal theo `ingredientId` + `unit`, `hasUnknownQuantity`, sắp xếp theo ngày/bữa), `MealPlannerChatService` / tools / prompt / refusals.
   - `NutritionChatController`, `NutritionChatService`, `GuestChatGuard`, `GuestSessionService`, `ClientIpService`, `nutrition-chat.dto.ts`.

7. **Knowledge, Messaging, Notifications, Admin Dashboard, Admin AI Costs, AI Telemetry, Qdrant (`test/unit/knowledge/`, `messaging/`, `notifications/`, `admin-dashboard/`, `admin-ai-costs/`, `ai/`, `qdrant/`):**
   - `KnowledgeController`, `KnowledgeModelsService`, `QdrantService`.
   - `MessagingController`, `MessagingService` (luật theo dõi `friends`/`requests`, `canSend`, idempotency `clientMessageId`, sequence & `readSequence`, `withUserLocks`), `MessagingEventsService` (SSE & MongoDB change stream), `messaging.dto.ts`.
   - `NotificationsController`.
   - `AdminDashboardController`, `AdminDashboardService` (mốc ngày Asia/Bangkok UTC+7, zero-fill ngày trống, kiểm tra `Number.isSafeInteger`), `dashboard.dto.ts`.
   - `AdminAiCostsController`, `AdminAiCostsService` (nearest-rank P95, `Decimal128`, duplicate charge, reconcile `GENERATION`, export CSV escape công thức & chặn >10.000 dòng), `ai-cost-query.dto.ts`.
   - `openrouter-client.ts`, `ai/chat/errors.ts`, `AiCostContext`, `AiCostTransportService` (JSON & SSE streaming buffer, ghi `ai_cost_calls` chịu lỗi DB).

---

## 4. Danh sách 11 TDD test đang đỏ (cố ý phơi bày bug trong `src/`)

| # | File test | Test case | Tag / Mô tả bug |
|---|---|---|---|
| 1 | `test/unit/common/common.spec.ts` | `rejects IPv4-mapped IPv6 loopback addresses` | `// BUG-SSRF-1`: `fetchPublicImage` chuyển `https://[::ffff:127.0.0.1]/img.png` qua `new URL()` thành `::ffff:7f00:1`, khiến `isPrivateIPv4('7f00:1')` trả về `false` và bỏ lọt SSRF. |
| 2 | `test/unit/posts/posts-query.service.spec.ts` | `keeps paging past an unpublished post in bookmarks` | `// BUG-M7`: `listBookmarks` lọc `PostStatus.PUBLISHED` sau khi lấy `limit + 1` bản ghi bookmark, làm `nextCursor` thành `null` sớm khi bản ghi lookahead chưa public. |
| 3 | `test/unit/profiles/profiles.flows.spec.ts` | `keeps paging past an unverified account in following list` | `// BUG-L-A4`: `ProfilesService.following` lọc tài khoản chưa xác minh email sau bước lấy `limit + 1`, làm dừng phân trang sớm. |
| 4–6 | `test/unit/notifications/notifications.flows.spec.ts` | 3 test fan-out & unread count | Bug sẵn có `M9` (2 test trùng thông báo like/follow khi gửi đồng thời) & `L-N1` (1 test đếm thông báo mất actor vào `unreadCount`). |
| 7–9 | `test/unit/knowledge/retrieval/knowledge-index.flows.spec.ts` | 3 test heading detection | Bug sẵn có `L-K4` (comment trong code block, trailing `#` trong `C#`, setext heading). |
| 10–11 | `test/unit/webhooks/storage/storage-webhook.flows.spec.ts` | 2 test event parsing | Bug sẵn có `L-P2` (percent-encoding lỗi gây `URIError` 500, record `null` gây `TypeError` 500 thay vì 400). |

### Các điểm đáng chú ý khác quan sát được khi đọc code (chưa có test fail)
- `src/media/cloudinary-webhook.controller.ts:65`: `JSON.parse(body)` chạy ngoài `validatePayload`, nên payload đã ký nhưng không phải JSON hợp lệ sẽ trả 500 thay vì 400.
- `src/messaging/messaging.controller.ts`: `authenticate()` bắt mọi lỗi (kể cả lỗi DB) thành `session.expired` thay vì `stream.unavailable`.
- `src/meal-plan/meal-plan.service.ts:243`: `suggestions` so khớp `ingredient.aliases.includes(text)` phân biệt chữ hoa/thường với alias viết hoa.
- `src/recipes/recipe-ratings.service.ts:137`: `{ $match: { 'user.emailVerifiedAt': { $ne: null } } }` sau `$lookup` sẽ vẫn khớp nếu tồn tại rating mồ côi có mảng `user: []`.

---

## 5. Lệnh chạy lại & Kiểm chứng

```bash
cd vedora-api

# 1. Lint & Build
npm run lint
npm run build

# 2. Chạy toàn bộ Unit Test + Coverage (yêu cầu MongoDB replica set đang chạy tại localhost:27017)
npm run test:cov
```
