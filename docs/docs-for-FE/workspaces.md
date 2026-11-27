# Fanpage nhà hàng (workspace) — hợp đồng API cho frontend

Cập nhật: 27/11/2026. Base URL mặc định khi chạy local:
`http://localhost:4000/api/v1`; frontend lấy từ `NEXT_PUBLIC_API_URL`.

Một **page** là account của nhà hàng (`accountType: "PAGE"`), có profile,
follower, bài đăng, thông báo và tin nhắn riêng. Nhiều người có thể quản lý
một page. Họ không đăng nhập vào page bằng mật khẩu, mà **chuyển phiên** từ
account cá nhân sang page. Page không có mật khẩu, không có Google, và có email
nội bộ không nhận được thư (khi hiển thị danh sách `/admin/users`, FE ẩn email của
account `PAGE` bằng ký hiệu `—` và không hiện thao tác sao chép email).

## Vòng đời

1. Chủ quán điền form 3 bước (hồ sơ quán → pháp lý theo loại hình → giấy tờ và
   cam kết), rồi gửi đơn → page ở trạng thái `PENDING`. Lúc này **account page
   chưa tồn tại**: không có profile, không tìm thấy trong search.
2. Admin xem đơn, giấy tờ và cảnh báo ở `/admin/workspaces`. Admin duyệt (`APPROVED`)
   sau khi tick đủ checklist, hoặc từ chối (`REJECTED`) kèm lý do.
3. Khi duyệt, API tạo account page với `username`, `name`, `bio` trong đơn.
   Từ đây, tên, bio, avatar và ảnh bìa được sửa ở profile của page
   (`PATCH /profiles/me` và các endpoint ảnh trong phiên page), như mọi account
   khác. **Username của page hiện không đổi được** sau khi duyệt
   (`PATCH /users/:id` bị chặn trong phiên page). Page không thể được cấp
   quyền `ADMIN` (`409 INVALID_ACCOUNT_TRANSITION`).
4. Đơn bị từ chối có thể gửi lại (`POST /workspaces/:id/resubmit`) với thông
   tin và minh chứng mới.

Mỗi người chỉ có **1 đơn đang chờ duyệt** tại một thời điểm (`409 APPLICATION_PENDING`).
Đơn đã được duyệt hoặc bị từ chối không tính. Page được duyệt là trạng thái cuối, hiện chưa có
thao tác thu hồi. Sau khi duyệt, địa chỉ và ghim bản đồ bị khóa.

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
`PATCH /users/:id` (cùng `DELETE /users/:id` — hiện đang tạm khóa cho phiên cá nhân/admin), toàn bộ `/billing/*`, `/payments/*`,
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

`POST /workspaces/proofs/uploads` với
`{ "kind": "<loại giấy>", "contentType": "image/jpeg" | "image/png" | "image/webp", "sizeBytes": 123 }`
→ `{ id, upload: { url, method: "PUT", headers, expiresAt } }`. PUT file lên
`upload.url`, rồi gửi `id` trong `proofIds`. Dung lượng mỗi ảnh dùng chung giới hạn
với huy hiệu đầu bếp (`VERIFICATION_PROOF_MAX_MB`). Mỗi đơn có tối đa 10 ảnh.

`kind` cho biết ảnh là gì. Mỗi loại là một ô upload riêng trên form:

| `kind` | Ảnh | Doanh nghiệp | Hộ kinh doanh | Cá nhân |
| ------ | --- | :---: | :---: | :---: |
| `ID_FRONT` | CCCD người đứng tên, mặt trước | Bắt buộc | Bắt buộc | Bắt buộc |
| `ID_BACK` | CCCD người đứng tên, mặt sau | Bắt buộc | Bắt buộc | Bắt buộc |
| `STOREFRONT` | Mặt tiền quán, thấy rõ biển hiệu và số nhà | Bắt buộc | Bắt buộc | Bắt buộc |
| `BUSINESS_LICENSE` | Giấy chứng nhận đăng ký doanh nghiệp / hộ kinh doanh | Bắt buộc | Bắt buộc | — |
| `FOOD_SAFETY` | Giấy chứng nhận ATTP | Khuyến khích | Khuyến khích | Khuyến khích |
| `MENU` | Ảnh thực đơn | Khuyến khích | Khuyến khích | Khuyến khích |
| `OTHER` | Giấy tờ khác | Tùy chọn | Tùy chọn | Tùy chọn |

Thiếu loại bắt buộc → `400 MISSING_PROOF`.

### Gửi đơn (form 3 bước)

```json
POST /workspaces
{
  "name": "Chay An Lạc - Bún Huế - Hàng Bông",
  "username": "chay.an.lac",
  "bio": "Quán chay gia đình",
  "provinceCode": "01",
  "wardCode": "00004",
  "address": "12 Hàng Bông",
  "longitude": 105.8482,
  "latitude": 21.0302,
  "businessForm": "EATERY",
  "vegetarianLevel": "VEGAN",
  "phone": "0901 234 567",
  "website": "https://anlac.example",
  "otherPlatformUrls": ["https://maps.app.goo.gl/…"],
  "legal": {
    "entityType": "HOUSEHOLD",
    "taxCode": "0123456789",
    "legalName": "Hộ kinh doanh Chay An Lạc",
    "legalAddress": "12 Hàng Bông, Hoàn Kiếm, Hà Nội",
    "representativeName": "Nguyễn Văn An",
    "contactEmail": "an@anlac.example"
  },
  "statement": "Tôi là chủ quán.",
  "proofIds": ["…"],
  "confirmsAccuracy": true,
  "consentsToReview": true
}
```

**Bước 1, hồ sơ quán:**

- `username`: cùng quy tắc với đăng ký (3–30 ký tự, `a-z0-9._-`).
- `provinceCode`: mã chính thức 2 số của một trong 34 tỉnh/thành sau sáp nhập 1/7/2025
  (ví dụ `01` Hà Nội, `79` TP.HCM). Danh sách ở `src/workspaces/vn-admin-units.ts`; FE có bản sao
  ở `features/workspaces/vn-provinces.ts` và `vn-wards.ts`.
- `wardCode`: mã chính thức 5 số của một phường/xã/đặc khu **thuộc** `provinceCode` (3.321 đơn vị).
  Sai tỉnh hoặc không tồn tại → `400 VALIDATION_FAILED`. BE tự lưu tên phường vào `ward`.
- Đơn gửi trước ngày 27/11/2026 dùng mã kiểu `ha-noi`; BE tự đổi sang mã chính thức khi khởi động.
  Đơn đó có `wardCode: null` và `ward` là tên tự nhập.
- `businessForm`: `RESTAURANT` (nhà hàng) · `EATERY` (quán ăn) · `STALL` (xe đẩy, quầy) ·
  `ONLINE` (chỉ bán mang đi hoặc online).
- `vegetarianLevel`: `VEGAN` (thuần chay) · `LACTO_OVO` (chay có trứng sữa) ·
  `VEGETARIAN_MENU` (quán có thực đơn chay riêng).
- `phone`: **bắt buộc**, có ít nhất 8 chữ số. Admin gọi số này để xác minh.
- `bio`, `website`, `otherPlatformUrls` (tối đa 5 link `http(s)`), `statement`: tùy chọn.

**Bước 2, pháp lý (`legal`):**

| Trường | `COMPANY` | `HOUSEHOLD` | `INDIVIDUAL` |
| ------ | --------- | ----------- | ------------ |
| `taxCode` | 10 số, hoặc `10số-3số` cho chi nhánh | 10 số (hoặc 10-3), hoặc CCCD 12 số | CCCD 12 số |
| `legalName` | Tên công ty, bắt buộc | Tên hộ kinh doanh, bắt buộc | Bỏ qua (lưu `null`) |
| `legalAddress` | Địa chỉ công ty | Địa chỉ hộ kinh doanh | Địa chỉ thường trú |
| `representativeName` | Người đứng tên pháp nhân | Người đứng tên | Chính chủ |
| `contactEmail` | Bắt buộc | Bắt buộc | Bắt buộc |

`taxCode` được bỏ khoảng trắng và dấu chấm trước khi kiểm tra.

Mọi `taxCode` 12 số (CCCD) còn phải đúng cấu trúc theo Thông tư 59/2021/TT-BCA, nếu sai trả `400`:

- 3 số đầu là mã tỉnh nơi đăng ký khai sinh, thuộc 63 mã cũ từ `001` (Hà Nội) tới `096` (Cà Mau), có
  số bị bỏ trống như `003`, `099`.
- Số thứ 4 là `0`–`3`: `0`/`1` là nam/nữ sinh 1900–1999, `2`/`3` là nam/nữ sinh 2000–2099.
- Số thứ 5–6 là năm sinh, không được sau năm hiện tại.

Kiểm tra này chỉ chặn số bịa, không chứng minh số đó là của người đứng tên. Admin vẫn phải đối chiếu
với ảnh CCCD.

**Bước 3, giấy tờ và cam kết:** `proofIds` phải đủ các loại bắt buộc (xem bảng ở trên).
`confirmsAccuracy` và `consentsToReview` phải là `true`.

**Lỗi:**

- `409 USERNAME_TAKEN`: username đã có account hoặc đang chờ duyệt.
- `409 APPLICATION_PENDING`: người này đã có một đơn đang chờ duyệt; mỗi người chỉ có 1 đơn chờ.
- `409 PROOF_NOT_UPLOADED`.
- `400 MISSING_PROOF`.
- `400 BAD_REQUEST`: proof không hợp lệ.
- `400 VALIDATION_FAILED`: sai định dạng, ví dụ MST không hợp loại hình hoặc chưa tick cam kết.

`POST /workspaces/:id/resubmit` nhận cùng body, và cũng phải gửi lại đủ giấy tờ.

`PATCH /workspaces/:id/details` nhận `address`, `longitude`, `latitude`,
`phone`, `website` (gửi đủ cả object). **Khi page đã được duyệt**, địa chỉ và ghim bị
khóa: gửi `address`, `longitude` hoặc `latitude` khác giá trị hiện tại thì nhận
`409 LOCKED_AFTER_APPROVAL`. SĐT và website vẫn sửa được.

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
  "provinceCode": "01" | null,
  "wardCode": "00004" | null,
  "ward": "Phường Ba Đình" | null,
  "businessForm": "EATERY" | null,
  "vegetarianLevel": "VEGAN" | null,
  "otherPlatformUrls": [],
  "statement": "…" | null,
  "legal": { "entityType": "HOUSEHOLD", "taxCode": "…", "legalName": "…" | null,
             "legalAddress": "…", "representativeName": "…", "contactEmail": "…" } | null,
  "status": "PENDING" | "APPROVED" | "REJECTED",
  "reviewNote": "…" | null,
  "rejectReason": "BLURRY_DOCUMENTS" | … | null,
  "reviewedAt": "…" | null,
  "createdAt": "…",
  "proofCount": 4,
  "role": "OWNER" | "MANAGER",
  "members": [
    { "userId": "…", "username": "…", "fullName": "…", "avatarUrl": null,
      "role": "OWNER", "createdAt": "…" }
  ]
}
```

- `legal` chỉ trả cho **owner**, vì MST có thể là số CCCD của họ. Manager nhận `null`.
- Đơn gửi trước form 3 bước có các trường mới là `null`, và `otherPlatformUrls` là `[]`.

`GET /workspaces/mine` trả mảng các object như trên nhưng không có `members`.
Sau khi duyệt, `username`, `name`, `bio`, `avatarUrl` lấy từ account page (luôn
là giá trị mới nhất).

Lỗi thành viên: `403 WORKSPACE_OWNER_REQUIRED`, `409 ALREADY_MEMBER`,
`409 WORKSPACE_NOT_APPROVED`, `404 NOT_FOUND` (không có user đó, hoặc user không
phải account cá nhân đang hoạt động). Người không phải thành viên nhận
`404 NOT_FOUND` như page không tồn tại.

## Admin

| Method | Endpoint                                 | Mô tả                                              |
| ------ | ---------------------------------------- | -------------------------------------------------- |
| GET    | `/admin/workspaces?status=&page=&limit=` | Danh sách đơn (phân trang page/limit)              |
| GET    | `/admin/workspaces/:id`                  | Chi tiết + `proofs` + `warnings`                   |
| GET    | `/admin/workspaces/:id/tax-code`         | Tra MST trong dữ liệu Cục Thuế (ở dưới)            |
| POST   | `/admin/workspaces/:id/review`           | Duyệt hoặc từ chối (body ở dưới)                   |

Mỗi item có các trường của `WorkspaceDetail` (gồm cả `legal`), cộng thêm:

- `owner: { id, username, fullName, email, avatarUrl } | null`;
- `committedAt`: lúc người gửi tick cam kết;
- `reviewChecklist`: checklist admin đã tick khi duyệt.

`GET /admin/workspaces/:id` trả thêm:

- `proofs: [{ id, kind, url }]`: URL ký, hết hạn sau 10 phút.
- `warnings: [{ code, workspaces: [{ id, name, status }] }]`. Đây là những điểm admin nên xem kỹ, **không chặn** việc duyệt:
  - `SAME_TAX_CODE`: đã có page được duyệt dùng cùng MST. Có thể là chi nhánh, nhưng cần xem.
  - `NEARBY_PAGE`: có page được duyệt ghim cách dưới 100 m.
  - `RECENT_REJECTION`: owner có đơn khác bị từ chối trong 30 ngày qua.

### Tra mã số thuế

`GET /admin/workspaces/:id/tax-code` tra MST của đơn trong dữ liệu công khai của Cục Thuế (qua VietQR, giữ kết quả 1 ngày). Gọi riêng, không nằm trong chi tiết đơn, vì nguồn chỉ cho vài lượt mỗi phút.

```json
{
  "status": "FOUND",
  "taxCode": "0101245486",
  "officialName": "TẬP ĐOÀN VINGROUP - CÔNG TY CP",
  "shortName": "VINGROUP",
  "address": "Số 7, Đường Bằng Lăng 1, …, TP Hà Nội",
  "taxStatus": "NNT đang hoạt động",
  "nameMatches": true,
  "sourceUpdatedAt": "2026-11-18T18:43:34.000Z"
}
```

- `status`:
  - `FOUND`: Cục Thuế có MST này.
  - `NOT_FOUND`: không có MST này. Nên từ chối với lý do `TAX_CODE_MISMATCH` sau khi xem lại.
  - `NOT_APPLICABLE`: MST cá nhân 12 số (số CCCD, không công khai) hoặc đơn mẫu cũ không có pháp lý.
  - `UNAVAILABLE`: nguồn lỗi hoặc hết lượt; thử lại sau, không phải lỗi của đơn.
- `nameMatches`: tên pháp lý trong đơn có khớp tên đăng ký không, bỏ qua dấu, hoa thường và cách viết loại hình ("Công ty TNHH", "CP"…). `null` khi không `FOUND`. Chỉ để admin xem kỹ, không chặn duyệt.
- `taxStatus`: nguyên văn của Cục Thuế, ví dụ "NNT đang hoạt động", "NNT ngừng hoạt động và đã đóng MST".

### Duyệt / từ chối

```json
POST /admin/workspaces/:id/review
{ "decision": "APPROVED",
  "checklist": { "identityMatches": true, "taxCodeVerified": true,
                 "storefrontMatches": true, "phoneConfirmed": true } }

{ "decision": "REJECTED", "rejectReason": "BLURRY_DOCUMENTS", "note": "Ảnh CCCD bị mờ" }
```

- **Duyệt** đơn có `legal` thì phải gửi `checklist` với cả 4 ô là `true`. Thiếu hoặc
  có ô `false` → `400 CHECKLIST_INCOMPLETE`. Đơn kiểu cũ (`legal: null`) không bắt buộc checklist.
- **Từ chối** thì phải có `rejectReason`:
  - `BLURRY_DOCUMENTS`: giấy tờ mờ;
  - `TAX_CODE_MISMATCH`: MST không khớp;
  - `IDENTITY_MISMATCH`: CCCD không khớp người đứng tên;
  - `STOREFRONT_MISMATCH`: mặt tiền không khớp địa chỉ;
  - `UNREACHABLE`: không liên lạc được;
  - `NOT_VEGETARIAN`: không phải quán chay;
  - `DUPLICATE`: trùng page đã có;
  - `OTHER`: lý do khác.

  `note` tùy chọn, nhưng bắt buộc khi lý do là `OTHER`. Owner thấy cả `rejectReason` lẫn `note`.
- Duyệt lại đơn đã xử lý → `409 WORKSPACE_NOT_REVIEWABLE`.
- Nếu username bị account khác lấy mất trong lúc chờ → `409 USERNAME_TAKEN`. Khi đó từ
  chối với `DUPLICATE` hoặc `OTHER` kèm ghi chú, để owner chọn username khác.

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
- `GET /restaurants/menu/search?q=…&limit=20&cursor=0` — tìm món ăn đang phục vụ qua Qdrant. Từ khóa 1–2 từ ("cơm", "bánh mì") chỉ ra món có chung ít nhất một chữ (có hoặc không dấu), xếp theo độ gần nghĩa; từ khóa dài hơn ("món nước thanh đạm") thì tìm cả theo nghĩa. Trả về món kèm `restaurant` (`pageUserId`, `username`, `name`, `avatarUrl`, `address`, `longitude`, `latitude`, `averageRating`, `reviewCount`) và `nextCursor`.

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
| 409  | `APPLICATION_PENDING`      | Đã có một đơn đang chờ duyệt                            |
| 409  | `LOCKED_AFTER_APPROVAL`    | Page đã duyệt không đổi được địa chỉ/ghim               |
| 400  | `MISSING_PROOF`            | Thiếu giấy tờ bắt buộc theo loại hình                   |
| 400  | `CHECKLIST_INCOMPLETE`     | Admin chưa tick đủ checklist khi duyệt                  |
