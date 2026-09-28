# Phân trang API danh sách

Backend có thành phần dùng chung tại `src/common/pagination`. Phân trang được áp dụng
cho GET danh sách; GET chi tiết theo ID, health check và `/auth/me` giữ response hiện tại.
Không cần migration database hoặc biến môi trường mới.

## 1. Phân trang theo page/limit

Endpoint đang áp dụng: `GET /api/v1/users`. Gửi header
`Authorization: Bearer <accessToken>` như trước.

**Thay đổi response:** endpoint này trước đây trả trực tiếp một mảng user; hiện trả
`{ items, meta }`. Frontend đọc danh sách từ `response.items`.

| Query   | Mặc định | Giá trị hợp lệ                 |
| ------- | -------- | ------------------------------ |
| `page`  | `1`      | Số nguyên từ `1` đến `1000000` |
| `limit` | `20`     | Số nguyên từ `1` đến `50`      |

Ví dụ lấy trang cuối của danh sách có 5 user, mỗi trang 2 user:

```http
GET /api/v1/users?page=3&limit=2
Authorization: Bearer <accessToken>
```

```json
{
  "items": [
    {
      "id": "4a1e32e4-e18e-4dd7-8b4a-246ef2113ff2",
      "username": "vedora.user",
      "fullName": "Vedora User",
      "email": "hello@vedora.vn",
      "createdAt": "2026-09-28T08:00:00.000Z",
      "updatedAt": "2026-09-28T08:00:00.000Z"
    }
  ],
  "meta": {
    "page": 3,
    "limit": 2,
    "totalItems": 5,
    "totalPages": 3,
    "hasNextPage": false,
    "hasPreviousPage": true
  }
}
```

| Trường meta       | Ý nghĩa                                                    |
| ----------------- | ---------------------------------------------------------- |
| `page`            | Trang được yêu cầu, bắt đầu từ 1                           |
| `limit`           | Số item tối đa trên một trang                              |
| `totalItems`      | Tổng số bản ghi khớp bộ lọc, trước khi phân trang          |
| `totalPages`      | `Math.ceil(totalItems / limit)`; bằng 0 khi danh sách rỗng |
| `hasNextPage`     | `page < totalPages`                                        |
| `hasPreviousPage` | `page > 1`, kể cả khi trang yêu cầu vượt tổng số trang     |

Danh sách user sắp xếp theo `createdAt DESC`, sau đó `id DESC` khi trùng thời điểm.
Backend đọc số lượng và dữ liệu trong cùng một snapshot database cho mỗi response.
Dữ liệu vẫn có thể thay đổi giữa hai request: khi thêm hoặc xóa bản ghi, vị trí item
trên các trang có thể dịch chuyển.

Các trường hợp cần xử lý:

- Không truyền query: lấy trang 1, tối đa 20 item.
- Danh sách rỗng: HTTP 200, `items: []`, `totalItems: 0`, `totalPages: 0`.
- Trang vượt `totalPages`: HTTP 200, `items: []`; `meta.page` giữ số trang đã yêu cầu.
- Query sai như `page=0`, `limit=51`, số thập phân, chuỗi không phải số, giá trị rỗng
  hoặc lặp cùng tham số: HTTP 400.
- Tham số không được endpoint khai báo như `skip`, `cursor` trên `/users`: HTTP 400.
- Thiếu access token hoặc token không hợp lệ: HTTP 401.

Kiểu TypeScript cho frontend:

```ts
export interface PaginationMeta {
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface PaginatedResponse<T> {
  items: T[];
  meta: PaginationMeta;
}
```

Khi đổi bộ lọc hoặc `limit`, frontend nên đưa `page` về 1. Dùng `totalPages` để hiển thị
số trang và các cờ để điều khiển nút chuyển trang.

## 2. Phân trang cursor cho bài đăng

`GET /api/v1/posts` dùng chung DTO/helper cursor và giữ nguyên hợp đồng hiện tại:

| Query      | Mặc định     | Giá trị hợp lệ                                 |
| ---------- | ------------ | ---------------------------------------------- |
| `limit`    | `20`         | Số nguyên từ `1` đến `50`                      |
| `cursor`   | Không truyền | UUID v4 lấy từ `nextCursor` của response trước |
| `authorId` | Không truyền | UUID của tác giả để lọc bài đăng               |

Response có dạng:

```ts
export interface CursorPaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
}
```

Luồng tải danh sách:

1. Trang đầu: gọi `/api/v1/posts?limit=20`.
2. Nếu `nextCursor` khác `null`, gọi tiếp
   `/api/v1/posts?limit=20&cursor=<nextCursor>`.
3. Giữ nguyên `authorId` và `limit` khi tải tiếp. Khi đổi bộ lọc, xóa cursor và tải lại.
4. `nextCursor: null` nghĩa là đã hết dữ liệu tại thời điểm request.

Endpoint bài đăng chỉ trả bài đã `PUBLISHED`, sắp xếp theo `publishedAt DESC`, rồi
`id DESC`. Response cursor không có `meta`, `totalItems` hoặc `totalPages`.
Không gửi `page` cho `/posts`; query không hợp lệ trả HTTP 400.

## 3. Quy ước cho GET danh sách mới

- API dạng bảng cần tổng số trang: dùng `page`/`limit` và `{ items, meta }`.
- Feed hoặc nút tải thêm: dùng `cursor`/`limit` và `{ items, nextCursor }`.
- Mỗi endpoint sẽ công bố bộ lọc riêng trong Swagger tại `/docs`.
- Backend tích hợp rõ ràng ở từng endpoint; không tự bọc mọi response GET.

Hướng dẫn tái sử dụng phía backend nằm trong mục **Phân trang dùng chung** của
[README](../../README.md#phân-trang-dùng-chung).
