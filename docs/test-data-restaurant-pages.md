# Bộ dữ liệu test: trang nhà hàng

Dùng để test đơn mở trang nhà hàng (form 3 bước), trang duyệt của admin và trang đã duyệt. Mọi dữ
liệu đều là giả. Mã số thuế 10 số bắt đầu bằng `99`, không phải mã tỉnh nào, nên không trùng doanh
nghiệp thật. Số CCCD thì phải có mã tỉnh và năm sinh thật mới qua được kiểm tra, nên 6 số cuối được đặt
là `0000xx`; đừng dùng các số này ở đâu khác. Ảnh giấy tờ là ảnh màu có ghi
"ẢNH TEST — KHÔNG PHẢI GIẤY TỜ THẬT".

## Chạy

```bash
docker compose up -d mongo rustfs      # cần MongoDB và RustFS local
npm run seed:restaurants
```

- Chỉ chạy được khi `DATABASE_URL` trỏ vào `localhost` hoặc `127.0.0.1`. Script từ chối chạy với DB server.
- Chạy lại bao nhiêu lần cũng được: mỗi lần chạy xóa dữ liệu của lần trước (tài khoản `@seed.vedora.test`,
  đơn, trang, ảnh) rồi tạo lại từ đầu. Dữ liệu khác trong DB không bị đụng tới.
- **Mật khẩu mọi tài khoản test = `SEED_USER_PASSWORD` trong `.env`**, giống tài khoản `vedora.admin`.

## Tài khoản và đơn có sẵn

| Đăng nhập | Đơn | Trạng thái | Dùng để test |
| --------- | --- | ---------- | ------------ |
| `test.chuquan.anh` | **A**: Chay Hoa Sen - Cơm chay (Hà Nội, hộ kinh doanh, MST `9900000001`) | ✅ Đã duyệt, có trang `@test-chay-hoa-sen` | Trang nhà hàng trên bản đồ và profile; chuyển sang dùng trang; địa chỉ và ghim bị khóa khi sửa |
| `test.chuquan.binh` | **B**: Chay Hoa Sen 2 - Lẩu nấm (Hà Nội, doanh nghiệp, **cùng MST với A**, cách A khoảng 50 m) | ⏳ Chờ duyệt | Admin thấy 2 cảnh báo: **trùng MST** và **có trang gần dưới 100 m** |
| `test.chuquan.cuong` | **C**: An Nhiên Chay - Bún Huế (TP.HCM, hộ kinh doanh, MST là CCCD `079200000003`) | ⏳ Chờ duyệt | Đơn "sạch": đủ 6 loại giấy (có ATTP và thực đơn), không cảnh báo → **duyệt** |
| `test.chuquan.dung` | **D1**: Xe chè chay cô Dung (Huế, cá nhân) | ❌ Bị từ chối 10 ngày trước (giấy tờ mờ) | Lịch sử từ chối |
| | **D2**: Xe chè chay cô Dung - Chè đậu (Huế, cá nhân, CCCD `046200000004`) | ⏳ Chờ duyệt | Cảnh báo **vừa bị từ chối trong 30 ngày**; đơn cá nhân không có ô ĐKKD; không có nút "Tra cứu MST" |
| `test.chuquan.em` | **E**: Bếp Chay Em - Cơm phần (Đà Nẵng, hộ kinh doanh) | ❌ Bị từ chối (MST không khớp, có ghi chú) | Owner thấy lý do từ chối → **"Sửa và gửi lại"** |
| `test.chuquan.phuong` | **F**: Quán Chay Phương (Cần Thơ) | ⏳ Chờ duyệt | Đơn **mẫu cũ**: không có pháp lý, ảnh không phân loại → nhãn "Đơn theo mẫu cũ", duyệt không cần checklist |
| `test.nguoimoi` | (chưa có đơn) | | Gửi đơn mới từ đầu bằng form 3 bước |

Admin duyệt bằng tài khoản `vedora.admin` ở `/admin/workspaces`.

## Kịch bản gợi ý

1. **Admin duyệt đơn sạch (C):** mở đơn C và kiểm tra 3 khối thông tin, 6 ảnh có nhãn, nút "Tra cứu MST"
   bị ẩn vì MST là số CCCD. Tick 3/4 mục checklist thì nút "Duyệt" vẫn khóa, tick đủ 4 thì mở → duyệt.
   Sau khi duyệt, trang `@test-an-nhien-chay` hiện trên bản đồ.
2. **Admin xem cảnh báo (B):** mở đơn B. Phải thấy khung "Cần xem kỹ" với 2 dòng, cả hai đều trỏ về
   "Chay Hoa Sen". Sau đó từ chối với lý do "Trùng với trang đã có".
3. **Cảnh báo bị từ chối gần đây (D2):** mở đơn D2, phải thấy cảnh báo nhắc tới đơn D1.
4. **Đơn mẫu cũ (F):** mở đơn F, phải có nhãn "Đơn theo mẫu cũ" và không có checklist. Bấm duyệt được ngay.
5. **Gửi lại đơn bị từ chối (E):** đăng nhập `test.chuquan.em`, mở "Trang nhà hàng". Phải thấy lý do
   "Mã số thuế không khớp tên pháp lý" kèm ghi chú → bấm "Sửa và gửi lại". Form điền sẵn thông tin cũ,
   chỉ cần chụp lại giấy tờ.
6. **Một đơn chờ mỗi người:** đăng nhập `test.chuquan.dung` (đang có D2 chờ duyệt) rồi gửi đơn mới →
   phải báo "Bạn đã có một đơn đang chờ duyệt".
7. **Khóa địa chỉ sau duyệt (A):** đăng nhập `test.chuquan.anh`, vào quản lý trang. Ô địa chỉ chỉ đọc,
   không có bản đồ để kéo ghim; SĐT và website vẫn sửa được.
8. **Gửi đơn mới (`test.nguoimoi`):** dùng các giá trị ở mục sau.

## Giá trị nhập sẵn cho đơn mới

Bước 1 (hồ sơ quán):

| Ô | Giá trị |
| - | ------- |
| Tên quán | `Chay Mới Mở - Cơm chay - Hai Bà Trưng` |
| Tên đăng nhập trang | `test-chay-moi-mo` |
| Tỉnh, thành phố / Phường, xã | Thành phố Hà Nội / Phường Hoàn Kiếm |
| Địa chỉ | `45 Hai Bà Trưng` |
| Vị trí | tab "Nhập tọa độ": vĩ độ `21.0250`, kinh độ `105.8530` |
| Hình thức / Loại ẩm thực | Quán ăn / Thuần chay |
| Số điện thoại | `0900 000 099` |

Bước 2 (pháp lý). Bảng dưới gồm giá trị **hợp lệ** và giá trị **phải bị chặn** để test kiểm tra MST:

| Loại hình | MST hợp lệ | MST phải bị chặn |
| --------- | ---------- | ---------------- |
| Doanh nghiệp | `9900000099`, `9900000099-001` | `001200000099` (12 số) |
| Hộ kinh doanh | `9900000098` hoặc `001200000098` | `12345`, `099200000098` (`099` không phải mã tỉnh) |
| Cá nhân | `001 200 000 097` (có dấu cách cũng được) | `9900000097` (10 số), `001900000097` (số thứ 4 là `9` = sinh sau năm 2100), `001230000097` (sinh năm 2030) |

Người đứng tên: `Ngô Mới Tạo`, email: `test.nguoimoi@seed.vedora.test`.

Bước 3: dùng ảnh bất kỳ trên máy (JPEG, PNG hoặc WebP, tối đa 10 MB). Cá nhân cần 3 ảnh (CCCD 2 mặt và mặt tiền),
doanh nghiệp và hộ kinh doanh cần thêm giấy ĐKKD. Tick 2 ô cam kết rồi gửi.

## Lưu ý

- Ảnh test được lưu dạng SVG. Form thật chỉ nhận JPEG, PNG hoặc WebP; SVG chỉ dùng cho dữ liệu seed để
  ảnh có chữ ghi rõ đó là giấy gì.
- Bấm "Tra cứu MST" với `9900000001` sẽ không tìm thấy công ty nào, đúng như mong đợi vì mã này là giả.
  Muốn thử tra cứu ra kết quả thì tự nhập MST của một doanh nghiệp công khai lúc gửi đơn.
- Muốn xóa hết dữ liệu test: chạy lại `npm run seed:restaurants` để reset về trạng thái ban đầu.
  Hiện chưa có lệnh chỉ xóa mà không tạo lại.
