# Báo cáo tìm bug API Vedora — 2026-11-17

Phạm vi: chỉ `vedora-api`. 5 subagent Opus phân tích luồng nghiệp vụ, lập ma trận test case (happy path, biên, input sai, phân quyền, chuyển trạng thái sai, idempotency, race, rò rỉ dữ liệu, error contract) và viết test theo hướng test-driven.

- Tổng cộng khoảng 776 test mới trong `test/`, tên file `*.flows.*`.
- 27 bug thật. Test lộ bug được để đỏ và đánh dấu `// BUG-n` (số BUG đánh riêng theo từng domain).
- Không sửa `src/`, không commit. Số liệu lấy từ báo cáo của agent, chưa chạy lại toàn bộ suite.
- `npm test`, `test:e2e`, `test:db` hiện đỏ có chủ đích cho đến khi sửa.

## Tổng quan

| Domain | Test mới | Đỏ | Bug |
|---|---|---|---|
| Auth, users, profiles, verification | 180 | 9 | 7 |
| Payments, subscriptions, webhooks | 124 | 5 | 2 |
| Posts, media, moderation | 139 | 5 | 4 |
| Recipes, meal-plan, nutrition-chat | 157 | 10 | 6 |
| Knowledge, messaging, notifications, admin | 176 | 11 | 8 |

## High

### H1. Đổi email không cần xác minh → chiếm tài khoản qua Google login
- Vị trí: `src/users/users.service.ts:91-110`, `src/auth/auth.service.ts:234-242`
- Test: `auth.flows` › "never signs a Google user into an account that only claimed their email without verifying it"
- Tái hiện: user A `PATCH /users/:id` đổi email thành email của nạn nhân, `emailVerifiedAt` vẫn giữ. Khi chủ email thật đăng nhập Google, `POST /auth/google` trả tài khoản của A (A biết mật khẩu).
- Sửa: đổi email 2 bước (lưu email chờ, chỉ thay sau khi xác minh mã). Chỉ xóa `emailVerifiedAt` là chưa đủ vì profile của chính user sẽ trả 404.

### H2. Chat lọt kiểm duyệt khi thêm lượt assistant sau tin nhắn bị gắn cờ
- Vị trí: `src/nutrition-chat/nutrition-chat.service.ts:54`, `src/meal-plan/meal-planner-chat.service.ts:71`; DTO `nutrition-chat.dto.ts:29`, `meal-plan.dto.ts:193`
- Test: "does not pass a flagged user message to the model by appending an assistant turn", "rejects a conversation that ends with an assistant turn"
- Thực tế: chỉ `messages.at(-1)` được kiểm duyệt; thêm một lượt assistant phía sau thì trả 200 và model vẫn thấy tin nhắn bị gắn cờ. Có trên endpoint guest công khai.
- Sửa: bắt buộc tin nhắn cuối `role === 'user'`, tốt hơn là kiểm duyệt mọi lượt user.

### H3. DELETE khi document đang INDEXING để lại point trong Qdrant
- Vị trí: `src/knowledge/knowledge.service.ts:207,226,383-388`, `knowledge-index.service.ts:104`
- Test: "leaves no Qdrant points when deleted while indexing"
- Thực tế: còn 2 point; document đã mất nên DELETE trả 404, API không dọn được, chatbot vẫn trích dẫn tài liệu đã xóa.
- Sửa (chung với M6 và L-K3): lưu `indexRunId` khi approve; ghi READY/`returnToReview` có điều kiện `{_id, status: INDEXING, indexRunId}`; gắn runId vào point, sau upsert xóa point cùng documentId khác runId; nếu update không khớp (đã xóa/reject/chạy lại) thì xóa point của lượt này.

## Medium

### M1. `PATCH /users/:id` lưu `null` vào trường bắt buộc
- Vị trí: `src/users/dto/update-user.dto.ts:18,30,41` (`@IsOptional` cho `null` qua), `users.service.ts:103-105`
- Test: `users.flows` › "rejects null for the required field email|fullName|username"
- Hệ quả (suy ra từ code): username `null` thì không đăng nhập bằng username được; token refresh mang `username: null` bị `JwtAuthGuard` từ chối, tài khoản tự khóa; email `null` vướng unique index.
- Sửa: `@ValidateIf((_, v) => v !== undefined)` thay `@IsOptional`.

### M2. `PATCH /profiles/me` với `{"bio": null}` trả 500
- Vị trí: `src/profiles/profiles.service.ts:97` (`dto.bio.trim()`), `profiles/dto/profile.dto.ts`
- Test: "rejects a null bio with 400 instead of crashing". Sửa như M1.

### M3. Xóa recipe đồng thời với favorite/rate lần đầu để lại bản ghi mồ côi
- Vị trí: `src/recipes/recipes.service.ts:80` không lấy lock `recipe:<id>` mà `recipe-favorites.service.ts:86` và `recipe-ratings.service.ts:67` có lấy.
- Test: "never leaves a favorite/rating pointing at a deleted recipe" (25/25 lần thử).
- Sửa: `lockDocument(..., 'recipe', id)` trong `remove`.

### M4. Danh sách favorites lệch `savedAt` và đếm thừa khi có favorite mồ côi
- Vị trí: `src/recipes/recipe-favorites.service.ts:51,72` (dùng `rows[index]` theo list đã lọc; count gồm dòng mồ côi). Hệ quả của M3.
- Sửa: mang cả dòng favorite theo từng recipe, loại hoặc dọn dòng mồ côi.

### M5. Xóa ingredient đồng thời với tạo recipe dùng nó
- Vị trí: `src/recipes/recipes.service.ts:59-60` (`assertReferences` ngoài transaction), `ingredients.service.ts:126`
- Test: "never both deletes an ingredient and saves a recipe that uses it" (cả hai thành công 25/25; recipe hiện tên ingredient rỗng).
- Sửa: kiểm tra tham chiếu và ghi trong cùng transaction, dùng lock chung theo ingredient ở cả hai phía.

### M6. Indexing bị cron bỏ rơi đánh dấu document đã REJECTED thành READY
- Vị trí: `src/knowledge/knowledge.service.ts:227-236,254` (update READY/`returnToReview` không guard trạng thái)
- Test: "keeps a document REJECTED when an interrupted indexing run finishes after the rejection"
- Điều kiện: lượt index chạy quá 15 phút (PDF nhiều ảnh, 1 batch 60 giây mỗi 8 ảnh). Sửa: như H3.

### M7. Danh sách bài đã lưu dừng phân trang sớm — đã sửa 2026-11-19
- Đã sửa: `nextCursor` tính từ các dòng bookmark trước khi lọc (`pageOfPublished`, dùng chung với `GET /posts/reposted-by/:userId`); trang có thể ít hơn `limit` bài.
- Vị trí: `src/posts/query/posts-query.service.ts:165-179` (`listBookmarks`)
- Test: "keeps paging past a saved post that is now held for review", "fills a page with saved posts that are still public"
- Thực tế: với A (public), B (bị ẩn), C (public), `limit=1` trả `[A]` và `nextCursor: null`, C không tới được. Cause: lọc published sau khi đã lấy `limit+1` dòng.
- Sửa: lọc trong query (`$lookup`) hoặc lấy tiếp đến khi đủ trang, hoặc tính `nextCursor` từ dòng chưa lọc.

### M8. Admin cầm bản cũ lưu đè chính sách moderation sau khi reset
- Vị trí: `src/moderation/moderation-settings.service.ts:78-90,97-99`
- Test: "refuses a save from a version loaded before a reset"
- Thực tế: reset xóa document, lần lưu kế tiếp lại có version 1, nên admin A (cầm version 1) lưu được 200 thay vì 409 và đè chính sách của admin C.
- Sửa: bộ đếm version chỉ tăng qua các lần reset (`$inc` + cờ mặc định, hoặc giữ tombstone).

### M9. Like/repost/follow đồng thời tạo thông báo trùng
- Vị trí: `src/notifications/notifications.service.ts:100-115` (find-then-create, không có unique index)
- Test: "creates one LIKE notification when the same like arrives twice at once" (2 dòng), "creates one FOLLOW notification when follow is toggled concurrently" (3 dòng)
- Sửa: partial unique index `(recipientId, actorId, type, postId)` cho các loại toggle, kèm upsert `$setOnInsert` hoặc bắt duplicate-key.

## Low

### Auth / users / profiles
- **L-A1. Mã xác minh email dùng được 2 lần khi song song** — `src/auth/email-verification.service.ts:110-131`. Kết quả [200, 200], 2 cặp token. Sửa: yêu cầu `deletedCount === 1` trong transaction hoặc thêm `emailVerifiedAt: null` vào filter, như `PasswordResetService.reset`.
- **L-A2. Mật khẩu khác vẫn đăng nhập nếu khớp 72 byte đầu** — `src/auth/auth.service.ts:83`. bcrypt cắt ở 72 byte, `LoginDto` chỉ giới hạn ký tự. Sửa: kiểm tra `truncates(dto.password)` trước `compare`, trả cùng 401 chung.
- **L-A3. Giới hạn độ dài profile kiểm trước khi trim** — `src/profiles/dto/profile.dto.ts:42`. `" " + 100 ký tự + " "` bị 400, docs nói tối đa 100 sau trim; bio tương tự (500). Sửa: thêm `@Transform(trim)`.
- **L-A4. Danh sách follower/following có thể kết thúc sớm** — `src/profiles/profiles.service.ts:228,378`. Lọc tài khoản ẩn xong mới quyết `nextCursor`. Hiện chỉ xảy ra khi follower bị xóa giữa hai lần đọc. Sửa: quyết định trang kế từ dòng chưa lọc.

### Payments / webhooks
- **L-P1. `q` chỉ gồm khoảng trắng bị bỏ qua thay vì 400** — `src/payments/admin/admin-payment-query.dto.ts:42`, `admin-payments.service.ts:65`. Orders, overview và export CSV đều trả toàn bộ. Sửa: `@Transform` trim trước `MinLength(1)`.
- **L-P2. Storage webhook nhận record sai định dạng trả 500 thay vì 400** — `src/storage/storage.service.ts:234,242` (record `null`, `%` lỗi trong key gây `TypeError`/`URIError`). Chỉ người giữ webhook token gây được. Sửa: kiểm tra hình dạng record, bắt `URIError` theo từng key, bỏ qua hoặc ném `InvalidInputException`.

### Posts / moderation
- **L-S1. Following feed sắp theo `createdAt` thay vì `publishedAt`** — `src/posts/query/posts-query.service.ts:201-214`. Bài được duyệt/xử lý video xong muộn bị chìm. Sửa: `{ publishedAt: -1, _id: -1 }` và `afterCursor('publishedAt', …)`.
- **L-S2. Blog AI không bắt buộc field `editor`** — `src/posts/dto/blog-ai.dto.ts:63-65`. Thiếu `editor` vẫn lấy quota và gọi model kiểm duyệt rồi 503/500 (có hoàn vé nhưng tốn lượt gọi model). Sửa: `@IsDefined()`/`@IsObject()`.

### Recipes / meal-plan / chat
- **L-R1. Meal plan có thể lưu recipe vừa bị xóa (race, ~1/25–100)** — `src/meal-plan/meal-plan.service.ts:167`. `apply()` chạy `preview()` ngoài transaction, trước lock user. Sửa: kiểm tra trong transaction sau khi lock.
- **L-R2. Request guest sai định dạng vẫn tốn quota ngày** — `src/nutrition-chat/guest/guest-chat.guard.ts:30` (guard chạy trước `ValidationPipe`). Sửa: trừ quota sau validation.

### Knowledge
- **L-K1. DELETE khi đang PROCESSING (OCR) để lại `knowledge_pages` mồ côi** — `knowledge.service.ts:120-128`. Sửa: ghi pages và AWAITING_REVIEW chỉ khi document còn PROCESSING (guarded `findOneAndUpdate` trong transaction).
- **L-K2. Kết quả OCR đến trễ làm document đã FAILED sống lại** — `knowledge.service.ts:140-150`. Cần stall >15 phút (`getBytes` và MuPDF không có timeout). Sửa như L-K1.
- **L-K3. Hai lượt index chồng nhau tạo point trùng** — `knowledge-index.service.ts:104-110`. Test: approve → cron trả về review → re-approve → cả hai xong; có 4 point thay vì 2. Search dedupe theo text nên ảnh hưởng là hao slot candidate, giảm recall. Sửa như H3.
- **L-K4. Regex heading mang sang trang khác không khớp Markdown/chunkdown** — `knowledge-index.service.ts:161-173` (`HEADING_LINE`, code do session này viết). 3 test: dòng comment trong code block bị coi là heading; `C#` thành `C` (CommonMark cần dấu cách trước chuỗi `#` đóng); setext heading không được mang sang trang sau. Sửa: lấy heading từ breadcrumbs của chunkdown hoặc parser Markdown thật.

### Notifications
- **L-N1. Thông báo mất actor được đếm là chưa đọc nhưng không hiện trong danh sách** — `notifications.service.ts:112,119,183-193,200`. Dòng được tạo trước khi kiểm tra actor. Xảy ra khi hard-delete user chạy đua với `notify`. Sửa: tra actor trước khi `create`.

## Rủi ro nghi ngờ, chưa xác nhận

**Auth / users**
- Đăng ký không có CAPTCHA hay rate limit; ai cũng khiến API gửi mã tới email bất kỳ, và đăng ký chưa xác minh chặn email đó 1 giờ.
- Google re-link: `googleId` bị ghi đè âm thầm khi email khớp nhưng `sub` khác (`src/users/accounts.service.ts:76`, `auth.service.ts:234`).
- 409 `CONFLICT` không có chi tiết field, dù `user-authorization.md` bảo FE hiển thị lỗi theo field.
- Admin tự duyệt yêu cầu verification của chính mình (`src/verification/verification.service.ts`, `review`).
- Login và refresh không có rate limit ngoài Turnstile ở login.
- Danh sách yêu cầu của admin bỏ yêu cầu có applicant không còn tồn tại nhưng `totalItems` vẫn đếm.
- `forgot` và `resend` trả lời nhanh hơn khi email không tồn tại (lộ email đã đăng ký).
- Docs chấp nhận, không tính bug: token không bị thu hồi khi suspend, profile tác giả bị suspend vẫn hiện, access token còn hạn sau reset mật khẩu.

**Payments**
- Replay idempotent khi payments bị tắt trả 503 thay vì trạng thái hiện tại (`payments.service.ts:186`).
- Route user không chuẩn hóa chữ hoa UUID (404), route admin thì có.
- Storage guard nhận token thô không có `Bearer ` và từ chối `bearer` viết thường.
- Transaction id từng bị ghi ignored (ví dụ `AMOUNT_MISMATCH`) có thể capture sau với payload khác cùng id.
- Quota: continuation sau lượt bị hoàn/từ chối bị tính như lượt mới; `AiUsageService.complete()` không kiểm tra `leaseUntil`.
- `errors.md` thiếu `AI_REQUEST_IN_PROGRESS`, `AI_REQUEST_ALREADY_PROCESSED`, `AI_REQUEST_EXPIRED`; `AI_QUOTA_EXCEEDED` mô tả là theo ngày dù gói trả phí tính theo chu kỳ.

**Posts**
- Không cấu hình `trust proxy`: sau Dokploy/Traefik mọi khách có thể chung IP nên lượt xem khách bị đếm thiếu.
- Following feed chỉ lấy `type: POST`, bỏ blog của người đang follow trong khi `GET /posts` trả cả hai; hành vi mong muốn chưa được ghi.
- Comment bị xóa để lại thông báo COMMENT trỏ `commentId` không còn.
- Khi bài đang duyệt lại sau khi sửa, like/unlike/sửa comment trả 404 nên không rút like được (đúng docs nhưng có thể gây bất ngờ).
- `post-comments-likes.md` ghi `GET /posts/:id` cần đăng nhập, code lại phục vụ khách.
- Đường publish video (READY → PUBLISHED) chưa được test end-to-end vì cloud giả.
- Tác giả gửi lại blog REJECTED không đổi nội dung nhiều lần để kiểm duyệt lại (theo thiết kế, nhưng model trả lời không nhất quán có thể lọt).

**Recipes / chat**
- Aggregate rating vẫn tính user SUSPENDED.
- `MealPlanService.suggestions` khớp alias chính xác và phân biệt hoa thường, khác catalog.
- Admin update recipe có thể có cùng race như M5 (chỉ test create).
- Hồ sơ ăn uống hoặc rule có thể đổi giữa `preview()` và lúc lưu (cùng gốc với L-R1).
- Quota guest nằm trong bộ nhớ từng instance: reset khi restart, không chia sẻ giữa instance.
- Moderation 503 vẫn tốn quota guest; các lượt user giả mạo trước đó không bao giờ bị kiểm duyệt.
- Schema zod của `proposeMealPlan` cho phép trùng ngày.
- Catalog nạp toàn bộ collection recipe vào bộ nhớ mỗi request.
- `apply()` dựng response ngoài transaction.

**Knowledge / hạ tầng**
- Rerank qua `@openrouter/sdk` yêu cầu `results[].document`; nếu provider bỏ qua thì mọi lần rerank lỗi và search âm thầm rơi về thứ tự fused.
- OCR do storage webhook kích hoạt bị ghi vào feature SYSTEM thay vì KNOWLEDGE (`ai-cost-context.ts`).
- `admin-dashboard.md` hứa snapshot RepeatableRead nhưng service chạy các query độc lập.
- `updatePage` kiểm tra trạng thái rồi mới ghi nên có thể xen kẽ với `approve`: sửa trả 200 nhưng không được index.
- `/health/ready` trả 500 thay vì 503 khi DB lỗi.
- chunkdown tạo chunk chỉ có heading (nhiễu) và chunk vượt 1.5× giới hạn (thấy 2202 ký tự).
- Search trước khi collection tồn tại ném lỗi, chatbot báo "unavailable" thay vì "không có đoạn nào".
- Point ảnh mang toàn bộ text trang, có thể rất lớn.
- `ai_cost_calls`: stream kết thúc sau khi đã reconcile thủ công (>15 phút) sẽ ghi đè cost đã reconcile bằng null trong `finish()`.
- `limit=0x10` và `limit=1e1` được DTO phân trang chấp nhận như số.
- `errors.md` thiếu `DOCUMENT_NOT_REVIEWABLE`.

## Test mới

| File | Test |
|---|---|
| `test/e2e/auth.flows.e2e-spec.ts` | 78 |
| `test/e2e/users.flows.e2e-spec.ts` | 39 |
| `test/e2e/profiles.flows.e2e-spec.ts` | 34 |
| `test/e2e/verification.flows.e2e-spec.ts` | 29 |
| `test/db/payments.flows.db-spec.ts` | 52 |
| `test/db/admin-payments.flows.db-spec.ts` | 22 |
| `test/db/subscriptions.flows.db-spec.ts` | 7 |
| `test/unit/payments/sepay-payload.flows.spec.ts` | 37 |
| `test/unit/webhooks/storage/storage-webhook.flows.spec.ts` | 10 |
| `test/e2e/post-interactions.flows.e2e-spec.ts` | 35 |
| `test/e2e/post-feeds.flows.e2e-spec.ts` | 16 |
| `test/e2e/post-moderation.flows.e2e-spec.ts` | 35 |
| `test/e2e/blogs.flows.e2e-spec.ts` | 28 |
| `test/e2e/moderation-settings.flows.e2e-spec.ts` | 17 |
| `test/unit/moderation/content-decision.flows.spec.ts` | 8 |
| `test/e2e/recipes.flows.e2e-spec.ts` | 64 |
| `test/e2e/recipe-engagement.flows.e2e-spec.ts` | 28 |
| `test/e2e/meal-plan.flows.e2e-spec.ts` | 34 |
| `test/e2e/assistant-chat.flows.e2e-spec.ts` | 31 |
| `test/e2e/knowledge.flows.e2e-spec.ts` | 64 |
| `test/unit/knowledge/retrieval/knowledge-index.flows.spec.ts` | 18 |
| `test/unit/knowledge/retrieval/knowledge-models-costs.flows.spec.ts` | 14 |
| `test/unit/notifications/notifications.flows.spec.ts` | 18 |
| `test/e2e/messaging-notifications.flows.e2e-spec.ts` | 33 |
| `test/e2e/admin-insights.flows.e2e-spec.ts` | 29 |

Chạy:

```bash
npx vitest run --config ./vitest.config.e2e.mts test/e2e/<file>
npx vitest run --config ./vitest.config.db.mts test/db/<file>
npx vitest run test/unit/<file>
```

## Lưu ý

- Hai agent chạy `prettier --write` bằng glob nên đã định dạng lại file test của các agent khác (chỉ đổi bố cục). ESLint còn báo biến `member` không dùng ở `test/e2e/recipes.flows.e2e-spec.ts:56`.
- `test/db/recipe-favorites.db-spec.ts` có 2 test đỏ sẵn từ trước: module test không đăng ký `AppExceptionFilter`, là lỗi cấu hình test, không phải bug `src/`.
- Spec knowledge dùng Qdrant thật với collection riêng `knowledge_flows_<uuid>` và từ chối chạy nếu collection không được cô lập. Lần chạy đầu cấu hình sai đã trỏ vào `vedora_knowledge` nhưng chỉ gửi delete-by-filter cho UUID ngẫu nhiên, mọi upsert bị từ chối vì sai số chiều nên không có thay đổi nào.
- Về nutrition totals: model không có dữ liệu calo hay dinh dưỡng và docs nói rõ, nên không có gì để test.
