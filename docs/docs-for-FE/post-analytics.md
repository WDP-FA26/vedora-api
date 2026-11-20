# Thống kê bài viết cho tác giả

Base URL: `/api/v1`. Mọi endpoint cần Bearer và chỉ trả số liệu của **chính
người gọi**; không có tham số chọn user khác (kể cả Admin). Response có
`Cache-Control: private, no-store`.

| Method | Endpoint | Kết quả |
| --- | --- | --- |
| GET | `/analytics/posts/summary?from&to` | Tổng trong kỳ, kỳ trước cùng độ dài, chuỗi theo ngày |
| GET | `/analytics/posts?from&to&sort&page&limit` | Danh sách bài đang công khai, kèm số liệu trong kỳ |

## Khoảng ngày

`from`/`to` là ngày `YYYY-MM-DD` theo giờ Bangkok (UTC+7), tính cả hai đầu,
tối đa 90 ngày, phải gửi cả hai hoặc không gửi (mặc định 30 ngày gần nhất).
Sai định dạng, thiếu một đầu, đảo ngược, quá 90 ngày hoặc gửi field lạ trả
`400` (`INVALID_DASHBOARD_RANGE` hoặc lỗi validation) — cùng luật với
`/admin/dashboard`.

`previousRange` là cùng số ngày ngay trước `from`, dùng để so sánh kỳ trước.

## Số liệu được tính thế nào

Chỉ tính trên bài (`POST` và `BLOG`) **hiện đang `PUBLISHED`** của người gọi.
Bài bị gỡ, bị từ chối, đang chờ duyệt hay bản nháp không được tính.

| Field | Nguồn |
| --- | --- |
| `likes` | Lượt Thích của **người khác** (không tính tự Thích) |
| `comments` | Bình luận và trả lời của người khác |
| `reposts` | Lượt đăng lại của người khác |
| `saves` | Lượt lưu (bookmark) của người khác. Chỉ có số, không bao giờ trả ai đã lưu |
| `newFollowers` | Lượt theo dõi người gọi |
| `publishedPosts` | Bài của người gọi xuất bản trong ngày đó |
| `views` | Lượt xem theo ngày (xem bên dưới) |

Thích, lưu, theo dõi… bị gỡ thì bản ghi bị xóa, nên số trong kỳ là **số bản ghi
hiện còn**, không phải lịch sử mọi thao tác. FE nên ghi rõ điều này.

### Lượt xem

`POST /posts/views` vẫn tăng `Post.viewCount` (trọn đời) như trước, và từ bản
này còn cộng vào bảng theo ngày `post_view_days`. Dữ liệu theo ngày **chỉ có từ
lúc bản này được triển khai**; không ước lượng hay bù số cũ.

- `viewsTrackedSince`: ngày đầu tiên có dữ liệu theo ngày trên toàn hệ thống, hoặc
  `null` nếu chưa có.
- Ngày trước `viewsTrackedSince`: `daily[].views = null` — nghĩa là **chưa có dữ
  liệu**, FE không được vẽ thành 0.
- `current.viewsComplete` / `previous.viewsComplete = false` khi một phần kỳ
  nằm trước `viewsTrackedSince`; lúc đó `views` chỉ là tổng các ngày đã theo dõi.
  Không so sánh lượt xem giữa hai kỳ trừ khi cả hai đều `true`.
- Lượt xem là số gần đúng: khử trùng lặp theo người xem trong 30 phút trên bộ nhớ
  của mỗi instance, có tính cả lượt tác giả tự xem, và ghi theo ngày lúc flush
  (mỗi vài giây). Nếu ghi bảng theo ngày lỗi, phần đó bị bỏ (tổng trọn đời không
  bị cộng hai lần).
- `snapshot.lifetimeViews` là tổng `viewCount` trọn đời, gồm cả lượt xem trước khi
  có bảng theo ngày.

## `GET /analytics/posts/summary`

```json
{
  "generatedAt": "2026-11-20T08:00:00.000Z",
  "range": { "from": "2026-10-01", "to": "2026-10-07", "timeZone": "Asia/Bangkok", "dayCount": 7 },
  "previousRange": { "from": "2026-09-24", "to": "2026-09-30" },
  "viewsTrackedSince": "2026-10-03",
  "snapshot": { "followers": 2, "publishedPosts": 2, "lifetimeViews": 42 },
  "current": {
    "views": 8, "viewsComplete": false,
    "likes": 1, "comments": 1, "reposts": 1, "saves": 3,
    "newFollowers": 1, "publishedPosts": 2
  },
  "previous": { "views": 0, "viewsComplete": false, "likes": 1, "...": "cùng field" },
  "daily": [
    { "date": "2026-10-01", "views": null, "likes": 0, "comments": 0, "reposts": 0,
      "saves": 0, "newFollowers": 1, "publishedPosts": 0 }
  ],
  "previousDaily": [
    { "date": "2026-09-24", "views": null, "likes": 0, "...": "cùng field" }
  ]
}
```

`previousDaily` có cùng dạng và cùng số phần tử với `daily`, là từng ngày của
`previousRange` (phần tử thứ i của hai mảng cùng vị trí trong kỳ), dùng để vẽ
đường so sánh kỳ trước.

`daily` luôn đủ `dayCount` phần tử theo thứ tự ngày, ngày không có hoạt động là
0 thật (trừ `views` trước khi theo dõi là `null`). `snapshot` là số hiện tại,
không phụ thuộc khoảng ngày.

## `GET /analytics/posts`

Query: `from`, `to` như trên; `page` (mặc định 1), `limit` (mặc định 20, tối đa
50); `sort` ∈ `recent` (mặc định, mới xuất bản trước), `views`, `saves`,
`likes`, `comments`, `reposts` (theo số trong kỳ, cao trước; hòa thì mới xuất bản
trước, rồi theo `id`).

```json
{
  "items": [
    {
      "id": "…uuid…",
      "type": "POST",
      "title": "Đậu hũ sốt cà",
      "publishedAt": "2026-10-06T05:00:00.000Z",
      "lifetimeViews": 2,
      "period": { "views": 1, "likes": 0, "comments": 0, "reposts": 0, "saves": 2 }
    }
  ],
  "meta": { "page": 1, "limit": 20, "totalItems": 2, "totalPages": 1, "hasNextPage": false, "hasPreviousPage": false },
  "range": { "from": "2026-10-01", "to": "2026-10-07", "timeZone": "Asia/Bangkok", "dayCount": 7 }
}
```

`title` là tiêu đề blog, hoặc 140 ký tự đầu của nội dung bài (cắt thêm `…`),
hoặc `null` với bài không có chữ (chỉ video). Danh sách gồm mọi bài đang công
khai, kể cả bài xuất bản trước kỳ; `period` là hoạt động trong kỳ.

## Gợi ý hiển thị (sản phẩm "calm")

- Không xếp hạng với người khác, không bảng xếp hạng, không hiệu ứng mốc.
- So sánh kỳ trước bằng chữ trung tính (ví dụ "+3 so với 7 ngày trước"), không
  dùng mũi tên đỏ/xanh.
- Ưu tiên lượt lưu hơn lượt xem.

Chưa có số liệu công thức: hiện chỉ Admin tạo được công thức (catalog), nên
chưa có "công thức của bạn được lưu" cho thành viên.
