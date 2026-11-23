# Fanpage nhà hàng (workspace) — hợp đồng API cho frontend

Cập nhật: 21/11/2026. Base URL mặc định khi chạy local:
`http://localhost:4000/api/v1`; frontend lấy từ `NEXT_PUBLIC_API_URL`.

Một **page** là account của nhà hàng (`accountType: "PAGE"`), có profile,
follower, bài đăng, thông báo và tin nhắn riêng. Nhiều người có thể quản lý
một page. Họ không đăng nhập vào page bằng mật khẩu, mà **chuyển phiên** từ
account cá nhân sang page. Page không có mật khẩu, không có Google, và có email
nội bộ không nhận được thư.

## Vòng đời

1. Chủ quán upload ảnh minh chứng (giấy phép kinh doanh, chứng nhận ATTP, ảnh
   mặt tiền), rồi gửi đơn → page ở trạng thái `PENDING`. Lúc này **account page
   chưa tồn tại**: không có profile, không tìm thấy trong search.
2. Admin xem đơn và minh chứng ở `/admin/workspaces`, rồi duyệt
   (`APPROVED`) hoặc từ chối kèm ghi chú (`REJECTED`).
3. Khi duyệt, API tạo account page với `username`, `name`, `bio` trong đơn.
   Từ đây, tên, bio, avatar và ảnh bìa được sửa ở profile của page
   (`PATCH /profiles/me` và các endpoint ảnh trong phiên page), như mọi account
   khác. **Username của page hiện không đổi được** sau khi duyệt
   (`PATCH /users/:id` bị chặn trong phiên page). Page không thể được cấp
   quyền `ADMIN` (`409 INVALID_ACCOUNT_TRANSITION`).
4. Đơn bị từ chối có thể gửi lại (`POST /workspaces/:id/resubmit`) với thông
   tin và minh chứng mới.

Một người có thể gửi nhiều đơn mở page (kể cả khi đang có đơn `PENDING` khác). Page được duyệt là
trạng thái cuối, hiện chưa có thao tác thu hồi.

Huy hiệu đầu bếp (`isProfessional`) là chuyện riêng, không liên quan và không
chặn việc mở page.

## Thành viên

| `role`    | Quyền                                                   |
| --------- | ------------------------------------------------------- |
| `OWNER`   | Người mở page. Thêm/xóa manager, gửi lại đơn bị từ chối |
| `MANAGER` | Chuyển sang page, sửa địa chỉ/liên hệ, tự rời page      |

Mọi thành viên đều có thể chuyển sang page và làm mọi việc với tư cách page.
Chỉ thêm manager được khi page đã `APPROVED`. Owner không thể bị xóa.

## Phiên page (chuyển account)

```http
POST /auth/switch
Authorization: Bearer <accessToken hiện tại>

{ "refreshToken": "<refreshToken hiện tại>", "pageId": "<pageUserId>" | null }
```

- `pageId` là `pageUserId` của page (id account page), **không phải** id
  workspace. `null` để quay lại account cá nhân.
- Refresh token hiện tại bị thu hồi ngay; response giống `POST /auth/login`
  (cặp token mới + `user`) và có thêm `actor`:

```json
{
  "accessToken": "…",
  "refreshToken": "…",
  "tokenType": "Bearer",
  "accessTokenExpiresIn": 3600,
  "refreshTokenExpiresIn": 2592000,
  "user": { "id": "<pageUserId>", "accountType": "PAGE", "…": "…" },
  "actor": {
    "id": "…",
    "username": "chef.an",
    "fullName": "An",
    "avatarUrl": null
  }
}
```

- FE lưu cặp token mới vào cookie như khi đăng nhập. Mọi request sau đó (Đăng
  bài, Thích, bình luận, follow, nhắn tin, thông báo…) đều nhân danh page.
- `GET /auth/me` và `POST /auth/refresh` trả thêm `actor`: là người đang dùng
  page, hoặc `null` trong phiên cá nhân. User object có thêm
  `accountType: "PERSONAL" | "PAGE"`.

Bảo mật:

- API kiểm tra quyền thành viên **ở mọi request**. Nếu manager bị xóa khỏi page,
  access token page của họ trả `401 PAGE_ACCESS_REVOKED` ngay.
- Nếu người đó bị khóa account, phiên page trả `401 ACCOUNT_SUSPENDED`.
- Xóa thành viên qua API thu hồi luôn refresh token page của họ, nên sau đó
  refresh trả `401` và FE đăng xuất như khi hết phiên (refresh token cá nhân đã
  bị thu hồi lúc chuyển sang page). Trường hợp hiếm: membership mất mà phiên
  page chưa bị thu hồi, thì refresh trả cặp token **của account cá nhân**
  (`actor: null`) thay vì đăng xuất.

Trong phiên page, các thao tác cấp tài khoản trả `403 PAGE_SESSION_NOT_ALLOWED`:
`PATCH/DELETE /users/:id`, toàn bộ `/billing/*`, `/payments/*`,
`/payment-intents/*`, `/dietary/*` (hồ sơ ăn uống & BMI), gửi yêu cầu huy hiệu
đầu bếp, tạo page mới, upload minh chứng và gửi lại đơn. Muốn làm những việc
này, chuyển về account cá nhân.

## Endpoint cho thành viên

Tất cả cần `Authorization: Bearer`. Trong phiên page, API dùng người đứng sau
(`actor`), nên trang quản lý page vẫn mở được khi đang là page.

| Method | Endpoint                          | Mô tả                                        |
| ------ | --------------------------------- | -------------------------------------------- |
| GET    | `/workspaces/mine`                | Các page bạn sở hữu/quản lý (mới nhất trước) |
| POST   | `/workspaces/proofs/uploads`      | Presigned upload cho ảnh minh chứng          |
| POST   | `/workspaces`                     | Gửi đơn mở page                              |
| GET    | `/workspaces/:id`                 | Chi tiết page + danh sách thành viên         |
| PATCH  | `/workspaces/:id/details`         | Sửa địa chỉ, vị trí, SĐT, website            |
| POST   | `/workspaces/:id/resubmit`        | Gửi lại đơn bị từ chối (owner)               |
| POST   | `/workspaces/:id/members`         | Thêm manager theo username (owner)           |
| DELETE | `/workspaces/:id/members/:userId` | Owner xóa manager, hoặc manager tự rời       |

### Upload minh chứng

Giống huy hiệu đầu bếp: `POST /workspaces/proofs/uploads` với
`{ "contentType": "image/jpeg" | "image/png" | "image/webp", "sizeBytes": 123 }`
→ `{ id, upload: { url, method: "PUT", headers, expiresAt } }`. PUT file lên
`upload.url`, rồi gửi `id` trong `proofIds`. Giới hạn dung lượng và số ảnh
dùng chung với huy hiệu đầu bếp (`VERIFICATION_*`).

### Gửi đơn

```json
POST /workspaces
{
  "name": "Chay An Lạc",
  "username": "chay.an.lac",
  "bio": "Quán chay gia đình",
  "address": "12 Hàng Bông, Hoàn Kiếm, Hà Nội",
  "longitude": 105.8482,
  "latitude": 21.0302,
  "phone": "0901 234 567",
  "website": "https://anlac.example",
  "statement": "Tôi là chủ quán, đính kèm giấy phép kinh doanh…",
  "proofIds": ["…"]
}
```

- `username`: cùng quy tắc với đăng ký (3–30 ký tự, `a-z0-9._-`).
- `bio`, `phone`, `website`: tùy chọn; chuỗi rỗng hoặc `null` thành `null`.
  `website` phải có `http://` hoặc `https://`.
- `longitude`, `latitude`: vị trí ghim trên bản đồ (Mapbox).
- `statement`: độ dài như yêu cầu huy hiệu đầu bếp.

Lỗi: `409 USERNAME_TAKEN` (username đã có account hoặc đang chờ duyệt),
`409 PROOF_NOT_UPLOADED`, `400 BAD_REQUEST` (proof không hợp lệ).

`PATCH /workspaces/:id/details` nhận `address`, `longitude`, `latitude`,
`phone`, `website` (gửi đủ cả object).

### Response `WorkspaceDetail`

```json
{
  "id": "<workspaceId>",
  "pageUserId": "<id account page>" | null,
  "username": "chay.an.lac",
  "name": "Chay An Lạc",
  "bio": "…" | null,
  "avatarUrl": null,
  "address": "…",
  "longitude": 105.8482,
  "latitude": 21.0302,
  "phone": "…" | null,
  "website": "…" | null,
  "statement": "…",
  "status": "PENDING" | "APPROVED" | "REJECTED",
  "reviewNote": "…" | null,
  "reviewedAt": "…" | null,
  "createdAt": "…",
  "proofCount": 2,
  "role": "OWNER" | "MANAGER",
  "members": [
    { "userId": "…", "username": "…", "fullName": "…", "avatarUrl": null,
      "role": "OWNER", "createdAt": "…" }
  ]
}
```

`GET /workspaces/mine` trả mảng các object như trên nhưng không có `members`.
Sau khi duyệt, `username`, `name`, `bio`, `avatarUrl` lấy từ account page (luôn
là giá trị mới nhất).

Lỗi thành viên: `403 WORKSPACE_OWNER_REQUIRED`, `409 ALREADY_MEMBER`,
`409 WORKSPACE_NOT_APPROVED`, `404 NOT_FOUND` (không có user đó, hoặc user không
phải account cá nhân đang hoạt động). Người không phải thành viên nhận
`404 NOT_FOUND` như page không tồn tại.

## Admin

| Method | Endpoint                                 | Mô tả                                                    |
| ------ | ---------------------------------------- | -------------------------------------------------------- |
| GET    | `/admin/workspaces?status=&page=&limit=` | Danh sách đơn (phân trang page/limit)                    |
| GET    | `/admin/workspaces/:id`                  | Chi tiết + `proofs: [{ id, url }]` (URL ký, 10 phút)     |
| POST   | `/admin/workspaces/:id/review`           | `{ "decision": "APPROVED" \| "REJECTED", "note"?: "…" }` |

Item có `owner: { id, username, fullName, email, avatarUrl } | null`. `note` bắt
buộc khi từ chối. Duyệt lại đơn đã xử lý → `409 WORKSPACE_NOT_REVIEWABLE`. Nếu
username bị account khác lấy mất trong lúc chờ → `409 USERNAME_TAKEN`; khi đó từ
chối kèm ghi chú để owner chọn username khác.

## Profile của page

`GET /profiles/:id` có thêm:

```json
{
  "accountType": "PAGE",
  "restaurant": {
    "workspaceId": "…",
    "address": "…",
    "longitude": 105.8482,
    "latitude": 21.0302,
    "phone": "…" | null,
    "website": "…" | null,
    "averageRating": 4.8,
    "reviewCount": 12
  }
}
```

Account cá nhân có `accountType: "PERSONAL"` và `restaurant: null`.

## Bản đồ nhà hàng (public)

```http
GET /restaurants?userLng=105.85&userLat=21.03
GET /restaurants?minLng=105.7&minLat=20.9&maxLng=106&maxLat=21.1&userLng=105.85&userLat=21.03
```

Trả về các page đã duyệt đang hoạt động.

- `minLng`, `minLat`, `maxLng`, `maxLat` là **tùy chọn** (gửi đủ cả 4 góc tây nam / đông bắc hoặc bỏ qua cả 4 để lấy tất cả nhà hàng trên hệ thống).
- Khi gửi đủ `userLng` và `userLat`, API sắp xếp gần người dùng nhất trước và trả thêm `distanceMeters` (mét). Khi không gửi tọa độ người dùng, API sắp xếp theo tên nhà hàng từ A → Z (tiếng Việt) và `distanceMeters: null`.

```json
{
  "items": [
    {
      "pageUserId": "…",
      "username": "chay.an.lac",
      "name": "Chay An Lạc",
      "avatarUrl": null,
      "address": "…",
      "longitude": 105.8482,
      "latitude": 21.0302,
      "distanceMeters": 350,
      "averageRating": 4.8,
      "reviewCount": 12
    }
  ],
  "truncated": false
}
```

Tối đa 200 điểm; `truncated: true` nghĩa là số kết quả vượt quá giới hạn 200. Khi có khung nhìn và khung rộng hơn nửa địa cầu (hoặc vắt qua kinh tuyến 180), API bỏ qua lọc khung nhìn. `minLat > maxLat`, gửi thiếu một phần trong 4 góc khung nhìn, hoặc gửi thiếu một trong hai `userLng`/`userLat` → `400`.

## Thực đơn nhà hàng

Thành viên page (chủ/quản lý) quản lý thực đơn qua:

| Method | Endpoint                          | Mô tả                                  |
| ------ | --------------------------------- | -------------------------------------- |
| GET    | `/workspaces/:id/menu`            | Danh sách món (kể cả món tạm hết)      |
| POST   | `/workspaces/:id/menu/image-uploads` | Presigned upload ảnh món ăn         |
| POST   | `/workspaces/:id/menu`            | Thêm món mới (tự index Qdrant)         |
| PATCH  | `/workspaces/:id/menu/:itemId`    | Cập nhật món / trạng thái phục vụ      |
| DELETE | `/workspaces/:id/menu/:itemId`    | Xóa món khỏi thực đơn và Qdrant        |

Public endpoints:

- `GET /restaurants/:pageUserId/menu` — thực đơn công khai của nhà hàng.
- `GET /restaurants/menu/search?q=…&limit=20&cursor=0` — tìm món ăn đang phục vụ qua Qdrant (dense + BM25 có/không dấu), trả về món kèm `restaurant` (`pageUserId`, `username`, `name`, `avatarUrl`, `address`, `longitude`, `latitude`, `averageRating`, `reviewCount`) và `nextCursor`.

## Đánh giá sao & bình luận nhà hàng

| Method | Endpoint                         | Mô tả                                                    |
| ------ | -------------------------------- | -------------------------------------------------------- |
| GET    | `/restaurants/:pageUserId/reviews?sort=newest\|highest\|lowest&page=1&limit=20` | Tóm tắt sao (1–5) + `myReview` (nếu đã đăng nhập) + danh sách bình luận |
| PUT    | `/restaurants/:pageUserId/reviews/me` | Tạo hoặc cập nhật đánh giá của bản thân (`rating`: 1..5, `comment`?: string) |
| DELETE | `/restaurants/:pageUserId/reviews/me` | Xóa đánh giá của bản thân                           |

Chỉ tài khoản cá nhân đã xác minh email và không phải thành viên quản lý nhà hàng đó mới gửi được đánh giá (thành viên nhận `403 SELF_RATING_NOT_ALLOWED`, phiên page nhận `403 PAGE_SESSION_NOT_ALLOWED`).

## Mã lỗi mới

| HTTP | `code`                     | Ý nghĩa                                                 |
| ---- | -------------------------- | ------------------------------------------------------- |
| 401  | `PAGE_ACCESS_REVOKED`      | Không còn quản lý page này; chuyển về account cá nhân   |
| 403  | `PAGE_SESSION_NOT_ALLOWED` | Thao tác cấp tài khoản, không làm được khi đang là page |
| 403  | `WORKSPACE_OWNER_REQUIRED` | Chỉ owner được làm                                      |
| 409  | `USERNAME_TAKEN`           | Username đã được dùng                                   |
| 409  | `WORKSPACE_NOT_APPROVED`   | Page chưa được duyệt                                    |
| 409  | `WORKSPACE_NOT_REVIEWABLE` | Đơn không ở trạng thái có thể duyệt/gửi lại             |
| 409  | `ALREADY_MEMBER`           | Người này đã quản lý page                               |
