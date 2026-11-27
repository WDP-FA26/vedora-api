# Rà soát hiệu năng MongoDB: schema, index, query

Ngày rà soát: 2026-11-26, trên `main` (`689acd5`).

**Tài liệu tham khảo:**
- [MongoDB Performance Best Practices](https://www.mongodb.com/resources/products/capabilities/performance-best-practices)
- [Query Optimization](https://www.mongodb.com/docs/manual/core/query-optimization/)

**Nguồn dữ liệu:**
1. Đọc toàn bộ `src/mongo/schemas/*.schema.ts` (khoảng 150 index).
2. Bật **profiler level 2** trên MongoDB ở máy, gọi các API public và mở các trang chính (home, thông báo, tin nhắn, thực đơn, đã lưu, hồ sơ, tìm kiếm, nhà hàng, các trang admin). Thu được 697 thao tác, gom nhóm theo dạng query và `planSummary`.
3. Chạy `explain("executionStats")` để xác nhận những chỗ đáng ngờ.

> Database ở máy rất nhỏ (nhiều nhất 142 ingredients, 36 recipes, 5 posts), nên con số thời gian không có ý nghĩa.
> Những gì đáng tin là **kế hoạch thực thi**: `COLLSCAN` (quét cả collection), `SORT` (sắp xếp trong RAM, gọi là in-memory sort), index nào được chọn.
> Các kế hoạch này giữ nguyên khi dữ liệu lớn lên, chỉ là chi phí tăng theo số document.

Ưu tiên: **P1** nên sửa sớm · **P2** nên sửa khi đụng tới · **P3** dọn dẹp, tùy chọn.

---

## Tóm tắt

| # | Vấn đề | Ưu tiên | Loại |
|---|---|---|---|
| 1 | Partial index `{ $type: 'string' }` **không được dùng** khi query bằng phép so sánh bằng, dẫn tới `COLLSCAN` (đăng nhập Google, thanh toán, page session) | P1 | Query |
| 2 | Feed và danh sách sắp xếp `-1` có `_id` làm tiêu chí phụ nhưng index không có `_id` hoặc sai thứ tự cột, nên phải sắp xếp trong RAM | P1 | Index |
| 3 | Bài của tác giả (trang hồ sơ, bản nháp) dùng nhầm index | P1 | Index |
| 4 | Tìm công thức/nguyên liệu bằng `$regex` không neo đầu chuỗi nên luôn `COLLSCAN`, lại phải gõ đúng dấu | P2 | Query/Schema |
| 5 | Danh sách công thức (public và admin) sắp theo `updatedAt` nhưng không có index | P2 | Index |
| 6 | Thanh toán của user (`userId` + `createdAt`) chọn index toàn cục, quét mọi giao dịch | P2 | Index |
| 7 | Thiếu TTL hoặc job dọn cho dữ liệu hết hạn (refresh token, OTP, log, chi phí AI) | P2 | Schema |
| 8 | Một số sort phụ thiếu cột trong index (media theo `position`, likes/bookmarks theo thời gian, indexer…) | P3 | Index |
| 9 | Index thừa hoặc trùng có thể bỏ | P3 | Index |
| 10 | Đếm số liệu dashboard bằng `$group` quét toàn bộ | P3 | Query |

Những chỗ **đã ổn** nằm ở cuối file.

---

## 1. Partial index với `$type: 'string'` không được dùng (P1)

CLAUDE.md quy định unique tùy chọn dùng `partialFilterExpression: { field: { $type: 'string' } }`. Cách này **giữ đúng tính unique**. Nhưng bộ lập kế hoạch query (query planner) chỉ dùng partial index khi điều kiện của query **suy ra được** bộ lọc của index. `{ field: 'abc' }` không suy ra được `{ field: { $type: 'string' } }`, nên planner bỏ qua index đó.

Kết quả `explain` ở máy:

```
payment_intents {activeIntentKey:"u1"}                          => COLLSCAN
payment_intents {activeIntentKey:{$eq:"u1",$type:"string"}}     => IXSCAN activeIntentKey_1
users           {googleId:"g1"}                                 => COLLSCAN
workspaces      {pageUserId:"u1", status:"APPROVED"}            => IXSCAN status_1_createdAt_1 (sai index)
```

**Chỗ bị ảnh hưởng:**

| Field (collection) | Code | Tần suất |
|---|---|---|
| `googleId` (`users`) | `src/users/accounts.service.ts:80` | Mỗi lần đăng nhập Google |
| `activeIntentKey` (`payment_intents`) | `src/payments/payments.service.ts:153, 208, 258` | Mỗi lần mở trang gói, tạo thanh toán. Profiler: 7 lần `COLLSCAN` |
| `providerTransactionId` (`payment_intents`) | `src/payments/payments.service.ts:433` | Mỗi webhook SePay |
| `pageUserId` (`workspace_members`) | `src/auth-core/page-access.ts:19`, `src/auth/refresh-tokens.service.ts:194`, `src/users/accounts.service.ts:59` | **Mỗi request** khi đang thao tác dưới danh nghĩa trang nhà hàng (JwtAuthGuard gọi `assertPageAccess`) |
| `pageUserId` (`workspaces`) | `src/workspaces/restaurant-menu.service.ts:255`, `src/profiles/profiles.service.ts:498` | Trang nhà hàng, hồ sơ |
| `toggleKey` (`notifications`), `recipeId` (`meal_log_entries`), `actorId` (`refresh_tokens`) | Chủ yếu dùng để giữ unique; cần kiểm lại nếu có query đọc theo field này | |

**Cách sửa** (chọn một):

- **A. Thêm `$type` vào query (khuyên dùng, không đổi schema).** Viết một helper dùng chung:
  ```ts
  // src/mongo/partial-match.ts
  /** Equality that can use a `{ $type: 'string' }` partial index. */
  export function presentString(value: string) {
    return { $eq: value, $type: 'string' } as const;
  }
  // this.users.findOne({ googleId: presentString(googleId), ...HUMAN_ACCOUNT })
  ```
  Sau đó thêm một dòng vào phần Conventions của CLAUDE.md: query đọc theo field có partial index phải dùng `presentString`.
- **B. Thêm index thường (không partial) cho các query đọc.** Ví dụ `WorkspaceMember { pageUserId: 1, userId: 1 }` bỏ partial, `Workspace { pageUserId: 1, status: 1 }`. Đơn giản nhưng tốn thêm index và chi phí ghi.

---

## 2. Sắp xếp `-1` kèm `_id` làm tiêu chí phụ: index không phục vụ được (P1)

CLAUDE.md yêu cầu sort có `_id` làm tiêu chí phụ (tie-breaker). Index chỉ phục vụ được sort khi **có đủ các cột sort, đúng thứ tự, và cùng chiều hoặc ngược chiều hoàn toàn**. Nhiều index thiếu `_id`, nên MongoDB phải đọc hết rồi sắp xếp trong RAM (stage `SORT`). Khi dữ liệu lớn, việc này tốn RAM, và vượt 100MB thì query báo lỗi nếu không bật `allowDiskUse`.

| Query (profiler) | Index đang dùng | Đề xuất (theo quy tắc ESR: Equality, Sort, Range) |
|---|---|---|
| Feed: `posts { status, type?, publishedAt ≤ … } sort { publishedAt: -1, _id: -1 }` (`posts-query.service.ts:170, 305`, `post-feed.service.ts:169`) | `{ status: 1, publishedAt: 1 }` rồi `SORT` | **Thay bằng** `{ status: 1, publishedAt: -1, _id: -1 }`. Nếu feed luôn lọc `type` thì dùng `{ status: 1, type: 1, publishedAt: -1, _id: -1 }` |
| Hàng chờ tóm tắt: `post_summaries { status, claimedAt, attempts } sort { claimedAt: 1, _id: 1 }` (12 lần) | `{ status: 1, claimedAt: 1 }` rồi `SORT` | `{ status: 1, claimedAt: 1, _id: 1 }` |
| Đã lưu: `post_bookmarks { userId } sort { createdAt: -1, _id: -1 }` | `{ userId: 1, createdAt: 1 }` rồi `SORT` | `{ userId: 1, createdAt: -1, _id: -1 }` (thay cho index cũ) |
| Admin user: `users {…} sort { createdAt: -1, _id: -1 }` | index `status…` rồi `SORT` | `{ createdAt: -1, _id: -1 }` nếu danh sách lớn |
| Hàng chờ kiểm duyệt dạng `$facet` (`verification_requests`, `workspaces`, `knowledge_documents`, `support_tickets`, `post_reports`, `comment_reports`) | `{ status: 1, createdAt: 1 }` rồi `SORT` | Thêm `_id` cùng chiều với sort, ví dụ `{ status: 1, createdAt: 1, _id: 1 }`. P3 vì các collection này nhỏ |

---

## 3. Bài của tác giả dùng nhầm index (P1)

| Query | Index đang dùng | Đề xuất |
|---|---|---|
| Hồ sơ: `posts { authorId, status, publishedAt } sort { publishedAt: -1, _id: -1 }` | `{ authorId: 1, createdAt: 1 }` rồi `SORT` | `{ authorId: 1, status: 1, publishedAt: -1, _id: -1 }` |
| Bản nháp: `posts { authorId, status, type, draftKind } sort { updatedAt: -1, _id: -1 }` (`post-drafts.service.ts:161`, 16 lần trong một lượt duyệt) | `{ status: 1, publishedAt: 1 }`, tức là quét **mọi bài cùng trạng thái của mọi người** rồi `SORT` | `{ authorId: 1, status: 1, updatedAt: -1, _id: -1 }` |

Sau khi thêm, index `{ authorId: 1, createdAt: 1 }` cũ chỉ còn dùng cho các query lọc theo `authorId`. Cần kiểm tra còn query nào sort theo `createdAt` không; nếu không còn thì bỏ, vì `authorId` là cột đầu của index mới.

---

## 4. Tìm công thức/nguyên liệu bằng `$regex` (P2)

`recipe-catalog.service.ts:157` (`matchingRecipeIds`) chạy `$regex` không neo đầu, có cờ `i`, trên `ingredients.name/aliases` và `recipes.title/description`. Profiler ghi nhận `COLLSCAN` ở cả hai collection (đọc 284 document để trả về 1).

- Regex không bắt đầu bằng `^` thì **không dùng index được**. Tài liệu MongoDB ghi rõ độ chọn lọc (selectivity) của regex phụ thuộc vào biểu thức.
- Còn một vấn đề về sản phẩm: phải gõ đúng dấu ("pho" không ra "Phở").

**Đề xuất** (từ nhẹ tới nặng):
1. **Thêm field chuẩn hóa** `searchText` vào `Recipe` và `Ingredient`: chữ thường, bỏ dấu, nối tên, mô tả và tên khác. Tạo khi lưu, tìm bằng `$regex` trên `searchText`. Vẫn là `COLLSCAN` nhưng chỉ trên một field ngắn, và **gõ không dấu vẫn ra**.
2. **Text index** `{ searchText: 'text' }` rồi dùng `$text`: dùng được index, nhưng tách từ không hợp tiếng Việt lắm.
3. **Dùng lại Qdrant BM25** như phần tìm bài, người dùng và món nhà hàng (`searchIndexedAt` + indexer). Cùng một cách với phần còn lại của app, có chuẩn hóa dấu sẵn. Khuyên dùng nếu kho công thức lớn dần.

---

## 5. Danh sách công thức sắp theo `updatedAt` không có index (P2)

`recipes.service.ts:39` (admin) và `recipe-catalog.service.ts:105` (public): `find().sort({ updatedAt: -1, _id: -1 })` cho ra `COLLSCAN` + `SORT` (6 lần trong lượt duyệt).

- Thêm `RecipeSchema.index({ updatedAt: -1, _id: -1 })`.
- Trang `/admin/recipes` ở FE tải **toàn bộ** công thức theo từng trang (`fetchAll`). Với vài nghìn công thức thì nên phân trang hoặc lọc ở server.

---

## 6. Thanh toán của user chọn index toàn cục (P2)

`payment_intents { userId } sort { createdAt: -1, _id: -1 }`: planner chọn index `{ createdAt: -1, _id: -1 }`, tức là **duyệt mọi giao dịch của mọi người** rồi lọc ra `userId`.

Index `{ userId: 1, createdAt: 1 }` có sẵn nhưng thiếu `_id`. Đổi thành `{ userId: 1, createdAt: -1, _id: -1 }`.

---

## 7. Dữ liệu hết hạn không được dọn (P2, schema)

Không có TTL index hoặc job `deleteMany` nào dọn những collection sau. Chúng chỉ tăng dần, làm phình working set (dữ liệu và index cần nằm trong RAM):

| Collection | Field | Đề xuất |
|---|---|---|
| `refresh_tokens` | `expiresAt` (đã có index thường) | Đổi thành TTL: `{ expiresAt: 1 }, { expireAfterSeconds: 0 }`. Token hết hạn thì không còn dùng để phát hiện tái sử dụng được nữa |
| `one_time_codes` | `expiresAt` | TTL `expireAfterSeconds: 0` |
| `document_locks` | thời điểm tạo hoặc lease | TTL nếu khóa có thời hạn |
| `system_logs`, `ai_cost_calls`, `payment_webhook_receipts`, `post_view_days` | `createdAt` / `startedAt` / `date` | TTL theo chính sách lưu trữ, ví dụ 90 ngày cho log, 1 năm cho chi phí. **Cần nhóm quyết định**, vì dashboard admin đọc số liệu lịch sử |

Đã có TTL: `messaging_events` (7 ngày).

Đổi index thường sang TTL phải xóa index cũ trước (hoặc dùng `collMod`), vì `autoIndex` không sửa được option của index đã tồn tại. Nhớ ghi chú điều này khi deploy.

---

## 8. Sort phụ thiếu cột (P3)

| Query | Đề xuất |
|---|---|
| `media_assets { postId } sort { position: 1 }` (7 lần, mỗi lần hiển thị bài) | `{ postId: 1, position: 1 }` thay cho `{ postId: 1 }` |
| `post_likes { userId } sort { createdAt: -1 }` (tab đã thích) | `{ userId: 1, createdAt: -1 }` thay cho `{ userId: 1 }` |
| `post_comments { authorId } sort { createdAt: -1 }` | `{ authorId: 1, createdAt: -1 }` thay cho `{ authorId: 1 }` |
| `meal_plan_week_entries { userId, weekStart } sort { position: 1 }` | Ít dòng mỗi tuần nên chấp nhận được |
| Indexer Qdrant: `posts/users/restaurant_menu_items { …, searchIndexedAt } sort { publishedAt/createdAt, _id }` | Chạy nền. Có thể thêm cột sort vào index `searchIndexedAt` nếu hàng chờ lớn |
| `incompatibility_rules` sort `createdAt` | Collection nhỏ, bỏ qua |

---

## 9. Index thừa hoặc trùng có thể bỏ (P3)

Mỗi index làm chậm việc ghi và chiếm RAM. Ứng viên để bỏ:

- `BodyMetricLog { userId: 1, date: -1 }`: **trùng** với unique `{ userId: 1, date: 1 }`, vì một index duyệt được cả hai chiều.
- `RefreshToken { userId: 1 }` và `{ familyId: 1 }`: giữ nếu thu hồi theo user/family. Kiểm tra bằng `$indexStats` trên production.
- `PostLike { userId: 1 }`, `PostComment { authorId: 1 }`, `MediaAsset { postId: 1 }`, `PostBookmark { userId: 1, createdAt: 1 }`, `PaymentIntent { userId: 1, createdAt: 1 }`: được **thay thế** bởi index mới ở mục 2, 6 và 8.
- `Post { status: 1, publishedAt: 1 }`: thay bằng index feed ở mục 2. Kiểm tra job tóm tắt (`publishedAt ≥`, sort tăng dần) vẫn dùng được index mới, vì index duyệt được ngược chiều.

**Trước khi bỏ index nào**, chạy trên production:
```js
db.<collection>.aggregate([{ $indexStats: {} }])   // xem accesses.ops từ lần khởi động gần nhất
```
Database ở máy không đủ để quyết định index nào không dùng tới.

---

## 10. Đếm số liệu dashboard (P3)

Admin overview chạy `$match {}` + `$group` trên `posts`, `recipes`, `support_tickets`, `post_reports`, `system_logs`, đều là `COLLSCAN`. Bình thường với dashboard, nhưng sẽ chậm dần. Khi số liệu lớn:
- Lọc theo khoảng thời gian có index (ví dụ `createdAt ≥ from`), hoặc
- Lưu sẵn bộ đếm (ví dụ `stats_daily` cập nhật bằng `$inc` khi tạo hoặc đổi trạng thái), đúng như gợi ý "store results of frequent sub-queries" trong tài liệu.

---

## Những chỗ đã ổn

- **Unique index cho mọi quan hệ nhiều-nhiều** (likes, reposts, bookmarks, follows, favorites, ratings) và các lookup `{ postId, userId }` đều `IXSCAN`.
- **Đếm thông báo chưa đọc, follow, chat thread** dùng `COUNT_SCAN`, chỉ đọc index, không đọc document.
- **Thông báo, tin nhắn, hội thoại, system log, support ticket**: sort theo index đúng chiều, không có in-memory sort.
- **Lấy user theo `_id`** (JwtAuthGuard, gắn tác giả vào bài): `EXPRESS_IXSCAN`, gom `$in` theo lô, không có N+1.
- **`messaging_events` `getmore COLLSCAN`** (84 lần) là **change stream** (`messaging-events.service.ts:84`) đọc oplog, không phải query của app. Bình thường.
- **Thiết kế schema** theo đúng hướng dẫn: tin nhắn chat, bình luận, media, tóm tắt AI tách collection riêng (tham chiếu), không nhúng mảng tăng vô hạn. Các mảng nhúng (`ingredients`, `nutritionPillars`, `requestHashes`, …) đều có giới hạn trong DTO.
- **Pipeline tóm tắt bài** (`post-summaries.service.ts:166`) giới hạn bằng cửa sổ thời gian và `$match` sớm trước `$lookup`. `$lookup` dùng được unique index `postId`.

---

## Đã làm trong PR 1 (`perf/mongo-index-fixes`)

- `presentString()` (`src/mongo/partial-match.ts`) được dùng ở: đăng nhập Google, `activeIntentKey` (3 chỗ) và `providerTransactionId` trong thanh toán, page access (JwtAuthGuard), refresh token (`pageUserId` và nhánh `$or` của `actorId`), trang nhà hàng (`workspaces.pageUserId` ở profiles và restaurant-menu). Đã ghi quy tắc vào CLAUDE.md.
- Index mới:
  - `posts { status: 1, publishedAt: -1, _id: -1 }`
  - `posts { authorId: 1, status: 1, publishedAt: -1, _id: -1 }`
  - `posts { authorId: 1, status: 1, updatedAt: -1, _id: -1 }`
  - `post_bookmarks { userId: 1, createdAt: -1, _id: -1 }`
  - `post_reposts { userId: 1, createdAt: -1, _id: -1 }`
  - `post_summaries { status: 1, claimedAt: 1, _id: 1 }`
- `test/e2e/mongo-query-plans.e2e-spec.ts` khẳng định các query trên dùng đúng index, không `COLLSCAN`, không `SORT`.

**Sau khi deploy:** `autoIndex` chỉ tạo index mới, **không xóa** index cũ. Kiểm tra index mới đã build xong (`db.<coll>.getIndexes()`), rồi xóa tay các index đã bị thay thế:

```js
db.posts.dropIndex('status_1_publishedAt_1')
db.posts.dropIndex('authorId_1_createdAt_1')
db.post_bookmarks.dropIndex('userId_1_createdAt_1')
db.post_reposts.dropIndex('userId_1_createdAt_1')
db.post_summaries.dropIndex('status_1_claimedAt_1')
```

## Kế hoạch áp dụng đề xuất

1. **PR 1 (P1):** helper `presentString` cho mục 1 và quy tắc trong CLAUDE.md; index feed, hồ sơ, bản nháp, hàng chờ tóm tắt, bookmarks cho mục 2 và 3. Mỗi index mới có một test `explain` trong `test/db` khẳng định `IXSCAN` và không có `SORT`.
2. **PR 2 (P2):** index `updatedAt` cho công thức, index thanh toán theo user, TTL cho `refresh_tokens` và `one_time_codes` (kèm ghi chú xóa index cũ khi deploy).
3. **Thảo luận nhóm:** chính sách lưu trữ log và chi phí; chọn cách tìm công thức (mục 4).
4. **Sau khi chạy production vài ngày:** `$indexStats` rồi bỏ index ở mục 9.

Có thể tạo lại kết quả profiler bằng cách: bật `db.setProfilingLevel(2)`, dùng app, gom `db.system.profile` theo `ns`, dạng filter, sort và `planSummary`, rồi lọc `COLLSCAN` và `hasSortStage`. Xong nhớ tắt (`setProfilingLevel(0)`) và `drop` `system.profile`.
