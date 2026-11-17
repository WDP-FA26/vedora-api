# Báo cáo tổng hợp Kiểm thử, Coverage & Danh sách Bug — Vedora API (2026-11-17)

Tài liệu này **gộp và chuẩn hóa** hai báo cáo kiểm thử trong ngày 2026-11-17:
1. [`docs/api-bug-hunt-report-2026-11-17.md`](./api-bug-hunt-report-2026-11-17.md) — rà soát luồng nghiệp vụ và viết ~776 test `*.flows.*` (unit/db/e2e) phơi bày 27 bug (`H1–H3`, `M1–M9`, `L-*`) và các rủi ro nghi ngờ.
2. [`docs/test-coverage-progress-report-2026-11-17.md`](./test-coverage-progress-report-2026-11-17.md) — bổ sung bộ unit test TDD phủ toàn bộ `src/**/*.ts` (từ 64 lên 155 file / 1.198 tests, đạt 98,77% Lines, **0/311 file dưới 80%**), đồng thời phát hiện thêm **1 bug High (`BUG-SSRF-1`)** và **4 điểm kỹ thuật cần lưu ý**.

> **Nguyên tắc TDD hiện tại:** Toàn bộ các test lộ bug được giữ **đỏ có chủ đích** và gắn nhãn `// BUG-*`; chưa chỉnh sửa mã nguồn `src/` cho đến khi xử lý theo danh sách dưới đây.

---

## 1. Tổng quan kiểm thử & Độ phủ (Coverage)

### 1.1. Tổng hợp Unit Test & Coverage (`npm run test:cov`)

| Chỉ số | Trước bổ sung TDD (64 file, 556 tests) | Sau bổ sung TDD (155 file, 1.198 tests) | Mức tăng |
|---|---:|---:|---:|
| **Lines** | 56,01% (2.978 / 5.316) | **98,77%** (5.251 / 5.316) | +42,76% |
| **Statements** | 55,26% (3.180 / 5.754) | **98,19%** (5.650 / 5.754) | +42,93% |
| **Functions** | 47,65% (723 / 1.517) | **98,81%** (1.499 / 1.517) | +51,16% |
| **Branches** | 44,94% (1.298 / 2.888) | **93,62%** (2.704 / 2.888) | +48,68% |
| **Số file `< 80%` (bất kỳ metric nào)** | 147 / 311 | **0 / 311** | Đạt 100% |

- **Chất lượng code & build:** `npm run lint` (`eslint "{src,test}/**/*.ts"`) và `npm run build` (`nest build`) đều **PASS** (0 lỗi, 0 cảnh báo).
- **Kết quả chạy unit test lần cuối (`npx vitest run --coverage`):**
  - **149 / 155 file PASS** (**1.187 / 1.198 tests PASS**).
  - **6 file FAIL (11 tests)** — toàn bộ 11 test đỏ đều là test TDD cố ý phơi bày bug: `common.spec.ts` (1: `BUG-SSRF-1`), `posts-query.service.spec.ts` (1: `BUG-M7`), `profiles.flows.spec.ts` (1: `BUG-L-A4`), `notifications.flows.spec.ts` (3: `M9` x2, `L-N1`), `knowledge-index.flows.spec.ts` (3: `L-K4` x3), `storage-webhook.flows.spec.ts` (2: `L-P2` x2).
- **Phạm vi file `src/`:** 239 file có mã thực thi (thấp nhất: `src/database/seed-catalog.ts` 90,38% Lines; `src/common/ffmpeg/ffmpeg.ts` 80,00% Branches) + 72 file thuần khai báo kiểu/decorator (0 câu lệnh thực thi).

### 1.2. Tổng hợp các bộ `*.flows.*` theo domain (Unit + DB + E2E)

| Domain | Bộ `*.flows.*` (báo cáo 1) | Bug xác nhận (đã gộp) | Ghi chú |
|---|---:|---:|---|
| Auth, users, profiles, verification | 180 tests (9 đỏ) | 7 (`H1`, `M1`, `M2`, `L-A1..A4`) | `L-A4` cũng tái hiện ở unit test `profiles.flows.spec.ts` |
| Payments, subscriptions, webhooks | 124 tests (5 đỏ) | 2 (`L-P1`, `L-P2`) | `L-P2` nằm trong unit test `storage-webhook.flows.spec.ts` |
| Posts, media, moderation | 139 tests (5 đỏ) | 4 (`M7`, `M8`, `L-S1`, `L-S2`) | `M7` cũng tái hiện ở unit test `posts-query.service.spec.ts` |
| Recipes, meal-plan, nutrition-chat | 157 tests (10 đỏ) | 6 (`H2`, `M3..M5`, `L-R1`, `L-R2`) | — |
| Knowledge, messaging, notifications, admin | 176 tests (11 đỏ) | 8 (`H3`, `M6`, `M9`, `L-K1..K4`, `L-N1`) | `M9`, `L-N1`, `L-K4` nằm trong unit test |
| Common / SSRF (bổ sung ở đợt coverage) | 1 test đỏ mới | **1 (`H4 / BUG-SSRF-1`)** | Phát hiện mới ở `common.spec.ts` |
| **Tổng cộng bug xác nhận** | — | **28 bug (4 High, 9 Medium, 15 Low)** | + **4 quan sát kỹ thuật** & danh sách rủi ro nghi ngờ |

---

## 2. Danh sách lỗi đã xác nhận & Gợi ý hướng xử lý

### 2.1. Mức độ High (4 lỗi — ưu tiên xử lý ngay)

| ID | Lỗi & Hậu quả | Vị trí & Test tái hiện | Gợi ý hướng xử lý phù hợp |
|---|---|---|---|
| **H1** *(Đã fix)* | **Đổi email không cần xác minh → chiếm tài khoản qua Google login.** Trước khi sửa, user A có thể đổi `email` sang email của nạn nhân qua `PATCH /users/:id` mà giữ nguyên `emailVerifiedAt`, rồi `POST /auth/google` trả về tài khoản của A. | `src/users/dto/update-user.dto.ts`, `src/users/users.service.ts:91-116`, `docs/docs-for-FE/user-authorization.md` (`auth.flows`, `users.flows`) | **Đã xử lý theo phương án không cho đổi email:** xóa `email` khỏi `UpdateUserDto` và `UsersService.update()` để `ValidationPipe` (`forbidNonWhitelisted`) từ chối mọi request đổi email với `400 VALIDATION_FAILED`; cập nhật contract FE và test (`users.service.spec.ts`, `users.flows.e2e-spec.ts`, `auth.flows.e2e-spec.ts`). |
| **H2** *(Đã fix)* | **Chat AI lọt kiểm duyệt khi chèn lượt `assistant` sau tin nhắn bị gắn cờ / leo thang ngữ cảnh đa lượt.** Trước khi sửa, chỉ `messages.at(-1)` được kiểm duyệt và DTO không chặn lượt cuối `assistant`. | `src/ai/guardrails/conversation-state.ts`, `src/nutrition-chat/nutrition-chat.service.ts`, `src/meal-plan/meal-planner-chat.service.ts`, `src/posts/blogs/ai/blog-assistant.service.ts`, `nutrition-chat.dto.ts`, `meal-plan.dto.ts` | **Đã xử lý theo hướng 2:** thêm `@LastMessageFromUser()` + `assertLastMessageFromUser()` ép lượt cuối là `user` trên `NutritionChatDto`/`MealPlannerChatDto`; dùng `conversationModerationState()` truyền toàn bộ lịch sử hội thoại `{ role, text }` vào 1 lần `decide()` trên cả 3 chat service và cập nhật `NUTRITION_POLICY` / `BLOG_ASSISTANT_POLICY`. Các test `BUG-4` & leo thang đa lượt trong `assistant-chat.flows.e2e-spec.ts` và unit test đều đã PASS. |
| **H3** | **`DELETE` khi document đang `INDEXING` để lại point mồ côi trong Qdrant.** Document đã bị xóa khỏi MongoDB nhưng job index chạy dở vẫn upsert 2 point vào Qdrant; chatbot tiếp tục trích dẫn tài liệu đã xóa. | `src/knowledge/knowledge.service.ts:207,226,383-388`, `src/knowledge/retrieval/knowledge-index.service.ts:104` | Gộp giải pháp cho `H3`, `M6`, `L-K3`: cấp `indexRunId` (UUID) mỗi lần `approve`; gắn `indexRunId` vào payload của từng point Qdrant; ghi `READY` / `returnToReview` bằng điều kiện nguyên tử `{ _id, status: INDEXING, indexRunId }`. Sau khi upsert xong, xóa các point cùng `documentId` có `indexRunId` khác; nếu update MongoDB không khớp (đã bị xóa/reject/chạy lượt khác) thì xóa ngay các point của `indexRunId` hiện tại. |
| **H4** *(Đã fix)* (`BUG-SSRF-1`) | **`fetchPublicImage` bỏ lọt SSRF qua địa chỉ IPv4-mapped IPv6 & blog từng cho chèn link ảnh ngoài.** Trước khi sửa, `new URL('https://[::ffff:127.0.0.1]/img.png')` chuẩn hóa hostname thành `[::ffff:7f00:1]` khiến `isPrivateAddress` trả `false`; đồng thời blog cho phép `coverImageUrl`/Markdown trỏ tới URL ngoài bất kỳ. | `src/common/http/fetch-public-image.ts`, `src/posts/blogs/blogs.service.ts`, `src/media/post-moderation.service.ts`, `src/cloudinary/cloudinary.service.ts`, `docs/docs-for-FE/blogs.md` (`common.spec.ts`, `blogs.service.spec.ts`, `blogs.flows.e2e-spec.ts`) | **Đã xử lý triệt để cả 2 lớp:** (1) Blog chỉ chấp nhận ảnh thuộc RustFS `StorageTarget.Blogs` (upload & ảnh AI) và video blog thuộc Cloudinary của hệ thống, chặn URL media ngoài với `BLOG_COVER_NOT_ALLOWED`/`BLOG_MEDIA_NOT_ALLOWED`, và `PostModerationService.downloadImage` chỉ đọc nội bộ từ RustFS (`getBytes`); (2) Sửa `fetchPublicImage` parse IPv6 8 từ 16-bit chuẩn hóa cả `::ffff:xxxx:yyyy` lẫn `::ffff:a.b.c.d`, `::/96`, `64:ff9b::/96`, `fc00::/7`, `fe80::/10`, `ff00::/8`. |

---

### 2.2. Mức độ Medium (9 lỗi)

| ID | Lỗi & Hậu quả | Vị trí & Test tái hiện | Gợi ý hướng xử lý phù hợp |
|---|---|---|---|
| **M1** | **`PATCH /users/:id` lưu `null` vào trường bắt buộc** (`email`, `fullName`, `username`). `@IsOptional()` cho phép `null` đi qua DTO, gây tự khóa tài khoản khi refresh token hoặc đụng unique index. | `src/users/dto/update-user.dto.ts:18,30,41`, `src/users/users.service.ts:103-105` (`users.flows`) | Thay `@IsOptional()` bằng `@ValidateIf((_, v) => v !== undefined)` trên các trường bắt buộc không cho phép `null` trong `UpdateUserDto`, để `null` bị từ chối với `400 VALIDATION_FAILED`. |
| **M2** | **`PATCH /profiles/me` với `{"bio": null}` trả 500** (`TypeError` khi gọi `dto.bio.trim()`). | `src/profiles/profiles.service.ts:97`, `src/profiles/dto/profile.dto.ts` (`profiles.flows`) | Dùng `@ValidateIf((_, v) => v !== undefined)` cho `bio` và `fullName` (hợp đồng xóa `bio` là gửi `""`), hoặc nếu muốn chấp nhận `null` thì chuẩn hóa rõ trong DTO & service; tối thiểu không để `null` lọt vào `.trim()`. |
| **M3** | **Xóa recipe đồng thời với favorite/rate lần đầu để lại bản ghi mồ côi.** `RecipesService.remove` không lấy `lockDocument(..., 'recipe', id)` trong khi favorite/rating có lấy. | `src/recipes/recipes.service.ts:80`, `recipe-favorites.service.ts:86`, `recipe-ratings.service.ts:67` | Lấy `await lockDocument(this.mongo, session, 'recipe', id)` bên trong `withTransaction` của `RecipesService.remove` (và các hàm mutate recipe liên quan) trước khi kiểm tra/xóa. |
| **M4** | **Danh sách favorites lệch `savedAt` và đếm thừa khi có favorite mồ côi.** Dùng `rows[index]` theo mảng recipe đã lọc và `countDocuments` vẫn tính dòng mồ côi (hệ quả của M3). | `src/recipes/recipe-favorites.service.ts:51,72` | Tra `row` theo `recipeId` (Map `recipeId -> row`) thay vì theo `index`, và dùng `$lookup` + lọc recipe tồn tại trong aggregation trước khi phân trang và đếm `totalItems` (kèm xử lý triệt để M3). |
| **M5** | **Xóa ingredient đồng thời với tạo recipe dùng nó.** `assertReferences` chạy ngoài transaction nên cả hai cùng thành công, để lại recipe tham chiếu ingredient đã xóa. | `src/recipes/recipes.service.ts:59-60`, `src/recipes/ingredients.service.ts:126` | Thực hiện `assertReferences` và ghi recipe bên trong cùng `withTransaction`, sử dụng lock theo danh sách `ingredient` (sắp xếp ID ổn định để tránh deadlock) ở cả `RecipesService` (create/update) và `IngredientsService.remove`. |
| **M6** | **Indexing bị cron bỏ rơi đánh dấu document đã `REJECTED` thành `READY`.** Hàm cập nhật `READY`/`returnToReview` không guard trạng thái `INDEXING` + `indexRunId`. | `src/knowledge/knowledge.service.ts:227-236,254` | Xử lý chung với **H3** bằng điều kiện cập nhật `{ _id, status: KnowledgeStatus.INDEXING, indexRunId }`. |
| **M7** | **Danh sách bài đã lưu (`listBookmarks`) dừng phân trang sớm.** Lọc `status === PUBLISHED` sau khi lấy `limit + 1` bản ghi bookmark, khiến `nextCursor` thành `null` sớm nếu bản ghi lookahead đang `DRAFT`/`PENDING_REVIEW`/`REJECTED`. | `src/posts/posts-query.service.ts:165-179` (`post-feeds.flows.e2e-spec.ts` & `test/unit/posts/posts-query.service.spec.ts`) | Dùng aggregation `$lookup` từ `post_bookmarks` sang `posts` với `$match: { 'post.status': PostStatus.PUBLISHED }`, `$sort`, `$limit: limit + 1` (hoặc lặp fetch theo batch cho đến khi gom đủ `limit + 1` bài `PUBLISHED` và lấy cursor từ dòng `PostBookmark` cuối cùng được giữ). |
| **M8** | **Admin cầm bản cũ lưu đè chính sách moderation sau khi `reset`.** `reset` xóa document nên lần lưu kế tiếp quay về `version: 1`, cho phép admin khác cầm `version: 1` trước khi reset ghi đè (200 thay vì 409). | `src/moderation/moderation-settings.service.ts:78-90,97-99` (`moderation-settings.flows`) | Không xóa document khi reset (hoặc dùng monotonic counter): giữ bản ghi settings với cờ `isDefault: true` và `$inc: { version: 1 }` mỗi lần `reset` hoặc `update`, đồng thời từ chối mọi `PUT` có `expectedVersion !== current.version` với `409 CONFLICT`. |
| **M9** | **Like/repost/follow đồng thời tạo thông báo trùng.** `NotificationsService.notify` kiểm tra tồn tại rồi mới `create` (find-then-create) mà không có unique index bảo vệ. | `src/notifications/notifications.service.ts:100-115` (`test/unit/notifications/notifications.flows.spec.ts`) | Thêm partial unique index trên `(recipientId, actorId, type, postId)` cho các loại toggle (`LIKE`, `REPOST`, `FOLLOW`), và dùng `findOneAndUpdate(..., { $setOnInsert: ... }, { upsert: true })` hoặc bắt mã lỗi trùng `11000` (chỉ phát SSE khi tạo mới thành công). |

---

### 2.3. Mức độ Low (15 lỗi)

| ID | Lỗi & Hậu quả | Vị trí & Test tái hiện | Gợi ý hướng xử lý phù hợp |
|---|---|---|---|
| **L-A1** | Mã xác minh email dùng được 2 lần khi gửi song song (`[200, 200]`, cấp 2 cặp token). | `src/auth/email-verification.service.ts:110-131` | Trong transaction, yêu cầu điều kiện `emailVerifiedAt: null` khi cập nhật user và `deletedCount === 1` khi tiêu thụ `OneTimeCode` (tương tự `PasswordResetService.reset`), nếu không thì rollback và ném lỗi `400`. |
| **L-A2** | Mật khẩu khác vẫn đăng nhập nếu khớp 72 byte đầu (bcrypt cắt ở 72 byte). | `src/auth/auth.service.ts:83` | Kiểm tra `truncates(dto.password)` trước `compare` (hoặc ngay đầu `login`); nếu vượt 72 UTF-8 bytes thì trả cùng `401 UNAUTHORIZED` chung (`Invalid credentials`) để không lộ thông tin. |
| **L-A3** | Giới hạn độ dài `fullName` (100) và `bio` (500) trong `UpdateProfileDto` kiểm tra trước khi trim. | `src/profiles/dto/profile.dto.ts:42` | Gắn `@Transform(({ value }) => typeof value === 'string' ? value.trim() : value)` lên `fullName` và `bio` trong DTO trước `@MaxLength` / `@MinLength`. |
| **L-A4** | Danh sách `followers`/`following` có thể kết thúc sớm khi tài khoản chưa xác minh/bị xóa nằm ở vị trí lookahead. | `src/profiles/profiles.service.ts:216-230,374-380` (`profiles.flows` & `test/unit/profiles/profiles.flows.spec.ts`) | Lọc `emailVerifiedAt != null` (và `status !== DELETED` nếu cần) trong pipeline `$lookup` tại MongoDB trước khi `.limit(query.limit + 1)`, hoặc quyết định `nextCursor` dựa trên các bản ghi hợp lệ đã lọc đủ `limit + 1`. |
| **L-P1** | Query `q` chỉ gồm khoảng trắng trên admin payments bị bỏ qua thay vì trả `400`. | `src/payments/admin/admin-payment-query.dto.ts:42`, `admin-payments.service.ts:65` | Thêm `@Transform` trim chuỗi trước `@MinLength(1)` trong `AdminPaymentQueryDto` (giống `SearchPostsQueryDto`), để chuỗi toàn khoảng trắng trả `400 VALIDATION_FAILED`. |
| **L-P2** | Storage webhook nhận `Records: [null]` hoặc key có `%` lỗi gây `TypeError`/`URIError` (500 thay vì 400). | `src/storage/storage.service.ts:234,242` (`test/unit/webhooks/storage/storage-webhook.flows.spec.ts`) | Kiểm tra shape từng record (`typeof record === 'object' && record !== null`, kiểm tra `s3?.object?.key` là string) và bọc `decodeURIComponent` trong `try/catch` để ném `InvalidInputException('BAD_REQUEST', ...)` thay vì 500. |
| **L-S1** | Following feed sắp xếp theo `createdAt` thay vì `publishedAt`, làm bài duyệt/xử lý video xong muộn bị chìm. | `src/posts/posts-query.service.ts:201-214` | Đổi sort sang `{ publishedAt: -1, _id: -1 }` và `afterCursor('publishedAt', ...)` (đồng bộ với `GET /posts`). |
| **L-S2** | Blog AI (`POST /blogs/ai/chat`) không bắt buộc field `editor`; thiếu `editor` vẫn trừ quota và gọi moderation rồi lỗi 503/500. | `src/posts/dto/blog-ai.dto.ts:63-65` | Thêm `@IsDefined()` và `@IsObject()` cho `editor` trong `BlogAiChatDto` để `ValidationPipe` trả `400` ngay trước khi chạm quota/AI. |
| **L-R1** | Meal plan `apply()` chạy `preview()` ngoài transaction trước khi khóa user → có thể lưu recipe vừa bị xóa (race). | `src/meal-plan/meal-plan.service.ts:167` | Chuyển bước đọc dữ liệu recipe/dietary/rules và kiểm tra hợp lệ vào bên trong `withTransaction` sau `lockDocument(..., 'user', userId)` (hoặc đọc lại trong cùng snapshot transaction với lock recipe). |
| **L-R2** | Request guest chat sai định dạng vẫn bị trừ quota ngày vì `GuestChatGuard` chạy trước `ValidationPipe`. | `src/nutrition-chat/guest/guest-chat.guard.ts:30` | Chỉ kiểm tra điều kiện đủ quota trong `GuestChatGuard`, còn thao tác **trừ quota** chuyển xuống controller/service sau khi `ValidationPipe` đã chạy (hoặc rollback quota khi validation fail). |
| **L-K1** | `DELETE` knowledge document khi đang `PROCESSING` (OCR) để lại `knowledge_pages` mồ côi. | `src/knowledge/knowledge.service.ts:120-128` | Thực hiện kiểm tra & ghi `KnowledgePage` + chuyển `AWAITING_REVIEW` trong một transaction có guarded `findOneAndUpdate({ _id, status: KnowledgeStatus.PROCESSING }, ...)`; nếu document không còn `PROCESSING` thì hủy/không insert pages. |
| **L-K2** | Kết quả OCR đến trễ (stall >15 phút) làm document đã `FAILED` sống lại thành `AWAITING_REVIEW`. | `src/knowledge/knowledge.service.ts:140-150` | Áp dụng chung cơ chế guarded state transition như **L-K1** (chỉ ghi kết quả nếu document vẫn đang `PROCESSING` và thêm timeout hợp lý cho `getBytes`/OCR/MuPDF). |
| **L-K3** | Hai lượt index chồng nhau (`approve` → cron trả về review → `re-approve` → cả hai xong) tạo point trùng trong Qdrant. | `src/knowledge/retrieval/knowledge-index.service.ts:104-110` | Xử lý chung với **H3** bằng `indexRunId` và xóa point của lượt cũ/lượt bị hủy. |
| **L-K4** | Regex `HEADING_LINE` mang heading sang trang sau xử lý sai code block, `C#` (cắt mất `#`) và bỏ sót setext heading. | `src/knowledge/retrieval/knowledge-index.service.ts:161-173` (`test/unit/knowledge/retrieval/knowledge-index.flows.spec.ts`) | Bỏ regex tự chế, thay bằng lấy heading/breadcrumbs trực tiếp từ AST/output của `chunkdown` hoặc parser Markdown chuẩn CommonMark (nhận diện fenced code block ` ``` `, quy tắc closing `#` cần khoảng trắng phía trước, và setext `===`/`---`). |
| **L-N1** | Thông báo mất actor được đếm vào `unreadCount` nhưng không hiện trong `GET /notifications`. | `src/notifications/notifications.service.ts:112,119,183-193,200` (`test/unit/notifications/notifications.flows.spec.ts`) | Tra cứu actor trước khi `create` thông báo (bỏ qua nếu actor đã xóa), và ở `unreadCount` dùng cùng điều kiện loại trừ thông báo có `actorId !== null` nhưng actor không còn tồn tại (hoặc đảm bảo `User` `onDelete` hook xóa đủ `Notification` liên quan trong transaction). |

---

## 3. Quan sát kỹ thuật bổ sung & Rủi ro nghi ngờ (chưa có test đỏ)

### 3.1. Quan sát kỹ thuật phát hiện khi viết Unit Test (mới)

1. **`src/media/cloudinary-webhook.controller.ts:65`** — `JSON.parse(body)` chạy trực tiếp ngoài `validatePayload`; nếu nhận webhook có chữ ký hợp lệ nhưng body không phải JSON hợp lệ sẽ ném `SyntaxError` (500).  
   → *Gợi ý:* Bọc `JSON.parse(body)` trong `try/catch` và ném `InvalidInputException('BAD_REQUEST', 'Invalid JSON body')`.
2. **`src/messaging/messaging.controller.ts:123-132,140-145`** — `authenticate()` bắt mọi exception (kể cả lỗi DB) thành `session.expired`; đồng thời nếu `frame(signal)` lỗi trong `live`, `observer.complete()` chỉ kết thúc `live` nhưng `heartbeat` vẫn chạy trong `merge(live, heartbeat)`.  
   → *Gợi ý:* Phân biệt lỗi auth (`UNAUTHORIZED`/`ACCOUNT_*`) với lỗi hạ tầng DB (`stream.unavailable` như `PaymentStreamController`), và truyền tín hiệu đóng chung cho `merge(live, heartbeat)` khi `live` kết thúc bất thường.
3. **`src/meal-plan/meal-plan.service.ts:243`** — `suggestions()` lọc `ingredient.aliases.includes(text)` phân biệt chữ hoa/thường và chỉ khớp nguyên chuỗi (khác `ingredient.name` và `RecipeCatalogService`).  
   → *Gợi ý:* Đổi sang `ingredient.aliases.some((alias) => includesText(alias))`.
4. **`src/recipes/recipe-ratings.service.ts:137`** — `{ $match: { 'user.emailVerifiedAt': { $ne: null } } }` sau `$lookup` sẽ vẫn khớp nếu tồn tại rating mồ côi có `user: []`.  
   → *Gợi ý:* Thêm điều kiện `'user.0': { $exists: true }` (hoặc `user: { $ne: [] }`) trong `$match`.

### 3.2. Rủi ro nghi ngờ theo domain (từ rà soát trước đó, kèm hướng xử lý)

- **Auth / Users / Verification:**
  - *Đăng ký không có CAPTCHA/rate limit* (cho phép spam gửi email và giữ chỗ email 1 giờ): cân nhắc bật Turnstile hoặc throttle theo IP cho `POST /auth/register`.
  - *Google re-link ghi đè `googleId` âm thầm khi trùng email nhưng khác `sub`* (`accounts.service.ts:76`): từ chối hoặc yêu cầu xác minh bổ sung nếu `user.googleId` đã tồn tại và khác `sub`.
  - *`409 CONFLICT` thiếu `details.field`* so với `user-authorization.md`: truyền `details: { field }` từ `rethrowUniqueViolation`.
  - *Admin tự duyệt verification của chính mình* (`verification.service.ts`): chặn `request.userId === adminId` với `403 FORBIDDEN`.
  - *Danh sách verification của admin đếm cả applicant đã mất trong `totalItems`*: dùng `$lookup` + lọc tồn tại trước khi đếm/phân trang.
  - *`forgot` / `resend` lộ thời gian phản hồi khi email không tồn tại*: chuẩn hóa thời gian xử lý hoặc chạy gửi mail async để tránh timing side-channel.
  - *Login/Refresh thiếu rate limit bổ sung*: cân nhắc throttle theo IP/tài khoản kết hợp Turnstile.
- **Payments / Quota:**
  - *Replay idempotent khi payments tắt trả `503` thay vì trạng thái đã lưu* (`payments.service.ts:186`): kiểm tra `PaymentRequest` theo `Idempotency-Key` trước khi chặn `PAYMENTS_DISABLED` (chỉ chặn tạo mới).
  - *Route user không chuẩn hóa UUID chữ hoa (404), route admin thì có*: chuẩn hóa lowercase UUID ở pipe/controller.
  - *Storage guard nhận token thô không có `Bearer ` và từ chối `bearer` thường*: chuẩn hóa parser header giống `extractBearerToken`.
  - *Transaction ID từng bị ghi ignored (ví dụ `AMOUNT_MISMATCH`) có thể capture lại với payload khác*: cân nhắc lưu/kiểm tra `providerTransactionId` đã từng xuất hiện hay thiết kế rõ idempotency theo đối soát.
  - *`AiUsageService.complete()` chưa kiểm tra `leaseUntil` & continuation sau lượt bị hoàn/từ chối tính như lượt mới*: thêm check `leaseUntil > now` khi complete và tách rõ quy tắc reset turn khi bị moderation chặn.
  - *`errors.md` thiếu tài liệu cho `AI_REQUEST_IN_PROGRESS`, `AI_REQUEST_ALREADY_PROCESSED`, `AI_REQUEST_EXPIRED`, `DOCUMENT_NOT_REVIEWABLE` và mô tả `AI_QUOTA_EXCEEDED` chưa cập nhật theo chu kỳ*: cập nhật `docs/docs-for-FE/errors.md`.
- **Posts / Moderation:**
  - *Thiếu `trust proxy`* (`app.setup.ts` / `main.ts`): sau Dokploy/Traefik mọi guest có thể dùng chung `request.ip`, làm đếm thiếu lượt xem guest → bật `app.set('trust proxy', 1)` (hoặc đọc header chuẩn có cấu hình).
  - *Following feed chỉ lấy `type: POST`, bỏ `BLOG` trong khi `GET /posts` lấy cả hai*: xác nhận lại product spec; nếu cần cả blog thì bỏ filter `type: POST` hoặc thêm query `type`.
  - *Xóa comment để lại thông báo `COMMENT` trỏ `commentId` không còn*: xóa `Notification` liên quan trong `PostComment` `onDelete` hook hoặc khi xóa comment.
  - *`post-comments-likes.md` ghi `GET /posts/:id` cần đăng nhập nhưng code phục vụ cả guest*: cập nhật lại docs cho khớp.
  - *Luồng publish video (`READY → PUBLISHED`) chưa có e2e thật vì cloud giả; tác giả gửi lại blog `REJECTED` giữ nguyên nội dung nhiều lần*: thêm integration/smoke test và giới hạn/hash nội dung nếu cần chống retry lạm dụng model.
- **Recipes / Meal-plan / Chat:**
  - *Aggregate rating vẫn tính user `SUSPENDED`*: thêm `'user.status': AccountStatus.ACTIVE` vào `$match` của `RecipeRatingsService.aggregate`.
  - *`AdminRecipesController` update có thể cùng race với `IngredientsService.remove` như M5*: khóa danh sách `ingredientId` trong transaction khi update recipe.
  - *`proposeMealPlan` zod schema cho phép trùng ngày; `MealPlanService.apply()` dựng response ngoài transaction*: ràng buộc unique `day` trong schema zod và bọc bước đọc response vào cuối transaction.
  - *Guest quota lưu in-memory theo instance; moderation 503 vẫn trừ quota guest*: chuyển bộ đếm guest sang Redis (nếu scale nhiều instance) và hoàn/không trừ quota khi moderation gặp `503`.
- **Knowledge / Hạ tầng:**
  - *Rerank SDK yêu cầu `results[].document` (nếu thiếu âm thầm fallback); search khi collection chưa tồn tại ném lỗi; chunkdown đôi khi sinh chunk chỉ có heading hoặc vượt 1,5× giới hạn; point ảnh mang toàn bộ text trang*: kiểm tra tồn tại collection trước khi search (trả empty hits), lọc bỏ chunk chỉ có heading và giới hạn độ dài text đính kèm point ảnh.
  - *OCR do storage webhook kích hoạt bị ghi feature `SYSTEM` thay vì `KNOWLEDGE`* (`ai-cost-context.ts`): bọc `aiCostContext.run({ feature: 'KNOWLEDGE', ... })` ở luồng kích hoạt OCR từ webhook.
  - *`updatePage` kiểm tra trạng thái ngoài lock với `approve`*: lấy lock hoặc update có điều kiện `{ _id: documentId, status: AWAITING_REVIEW }`.
  - *`admin-dashboard.md` ghi snapshot RepeatableRead nhưng chạy query độc lập*: chạy các query trong `mongo.withTransaction` (readConcern snapshot) nếu cần đúng hợp đồng snapshot.
  - *`/health/ready` trả 500 thay vì 503 khi DB lỗi*: bắt lỗi `mongo.ping()` và ném `FeatureUnavailableException` (`503`).
  - *`ai_cost_calls` stream kết thúc sau khi admin reconcile thủ công (>15 phút) ghi đè cost đã reconcile bằng `null`*: thêm điều kiện `reconciledAt: null` (hoặc `costSource: null`) khi `finish()` cập nhật `costUsd`.
  - *`limit=0x10` / `limit=1e1` được DTO phân trang chấp nhận như số*: dùng transform kiểm tra chuỗi thập phân nguyên `/^\d+$/` trước khi ép `Number`.

---

## 4. Đề xuất thứ tự khắc phục (Roadmap đề nghị)

1. **Đợt 1 — Bảo mật & Toàn vẹn dữ liệu (High):** `H1` (đổi email 2 bước), `H4 / BUG-SSRF-1` (chặn IPv4-mapped IPv6 trong `fetchPublicImage`), `H2` (moderation mọi lượt user trong chat), `H3` + `M6` + `L-K1..K3` (cơ chế `indexRunId` + guarded transition cho Knowledge).
2. **Đợt 2 — Race Condition & Dữ liệu sai lệch (Medium):** `M1` & `M2` (sửa `@ValidateIf` cho DTO), `M3` + `M4` + `M5` + `L-R1` (khóa `lockDocument` nhất quán cho recipe/ingredient/meal-plan), `M7` & `L-A4` (lọc trước lookahead cursor), `M8` (version moderation settings không reset về 1), `M9` & `L-N1` (unique index notification + check actor).
3. **Đợt 3 — Validation, Edge-case & Hạ tầng (Low + Quan sát mới):** `L-A1..A3`, `L-P1..P2`, `L-S1..S2`, `L-R2`, `L-K4`, cùng 4 điểm mới (`cloudinary-webhook.controller.ts`, `messaging.controller.ts`, `meal-plan.service.ts`, `recipe-ratings.service.ts`) và `/health/ready` 503, `trust proxy`, `errors.md`.
4. **Xác nhận sau khi sửa:** Sau mỗi đợt sửa trong `src/`, chạy lại `npm run lint`, `npm run build`, `npm run test:cov`, `npm run test:e2e`, `npm run test:db` cho đến khi toàn bộ 11 unit test đang đỏ (cũng như các test `*.flows.*` ở e2e/db) đều chuyển xanh.
