# Tóm tắt bài đăng bằng AI (Vedora AI)

Khi một bài đăng (bài thường có video hoặc chữ, hoặc blog) được **xuất bản**, backend
tự đọc nội dung — chữ của bài, transcript của video (sau khi caption xong), hoặc tiêu
đề + nội dung blog — và nhờ AI viết một bản tóm tắt ngắn. Nếu bài dạy cách nấu một món,
AI còn rút ra **công thức** (nguyên liệu, các bước, khẩu phần, thời gian).

Kết quả được:

1. **Lưu vào database** (collection `post_summaries`, một dòng mỗi bài), để sau này
   dùng tự điền form công thức.
2. **Bình luận vào bài** bởi tài khoản hệ thống **Vedora AI** (`author.isSystem: true`).

Không có thông báo nào được gửi cho chủ bài. Chủ bài (hoặc admin) có thể xóa bình luận
AI như mọi bình luận khác; AI sẽ không bình luận lại.

## Khi nào AI bỏ qua

- Bài xuất bản trước khi job chạy quá `POST_SUMMARY_WINDOW_SECONDS` (mặc định 24 giờ):
  bài cũ không được tóm tắt.
- Tổng nội dung (chữ + transcript) ngắn hơn `POST_SUMMARY_MIN_TEXT_LENGTH` (mặc định
  280 ký tự) → `SKIPPED`, không gọi AI.
- AI đánh giá không có gì đáng tóm tắt hoặc không liên quan ẩm thực → `SKIPPED`.
- Video còn đang transcribe → đợi đến khi có transcript.

Job chạy mỗi 10 giây, nên bình luận xuất hiện khoảng 10 giây cộng thời gian AI chạy
(thường dưới 30 giây) sau khi bài được xuất bản; video lâu hơn vì phải đợi caption.

## Đọc bản tóm tắt

```http
GET /api/v1/posts/:postId/summary
```

Công khai, không cần đăng nhập. 404 khi bài chưa xuất bản hoặc chưa được job nhận.

```json
{
  "postId": "11111111-1111-4111-8111-111111111111",
  "status": "READY",
  "language": "vi",
  "summary": "Cách làm đậu hũ sốt cà chua chay đơn giản cho 2 người.",
  "recipe": {
    "title": "Đậu hũ sốt cà chua",
    "description": null,
    "tag": null,
    "servings": 2,
    "prepMinutes": null,
    "cookMinutes": 10,
    "ingredients": [
      {
        "name": "đậu hũ non",
        "quantity": 300,
        "unit": "g",
        "note": "cắt khối"
      },
      { "name": "hành lá", "quantity": null, "unit": null, "note": null }
    ],
    "steps": [
      "Chiên đậu hũ vàng đều các mặt.",
      "Xào cà chua cho mềm, nêm nước tương."
    ]
  },
  "commentId": "22222222-2222-4222-8222-222222222222",
  "createdAt": "2026-11-21T08:00:00.000Z",
  "updatedAt": "2026-11-21T08:00:05.000Z"
}
```

| `status`  | Ý nghĩa                                                                          |
| --------- | -------------------------------------------------------------------------------- |
| `PENDING` | Đang tóm tắt (hoặc chờ thử lại sau lỗi, tối đa `POST_SUMMARY_MAX_ATTEMPTS` lần). |
| `READY`   | Có `summary`; `recipe` có thể null nếu bài không dạy món nào.                    |
| `SKIPPED` | Không có gì để tóm tắt; `summary` và `recipe` null.                              |
| `FAILED`  | AI lỗi ở lần thử cuối.                                                           |

`recipe` có cùng hình dạng với `Recipe` để tự điền form, với các khác biệt:

- `ingredients[].name` là **chữ tự do** như bài viết nói, **không phải** `ingredientId`
  của catalog — FE/BE phải tự khớp với catalog khi điền form.
- `servings`, `prepMinutes`, `cookMinutes`, `quantity`, `unit`, `note`, `tag` là `null`
  khi bài không nói rõ; AI được yêu cầu không đoán.
- `commentId` null khi bình luận AI đã bị xóa (hoặc bài không còn xuất bản lúc đăng).

## Tài khoản Vedora AI

- `username: "vedora.ai"`, `fullName: "Vedora AI"`, `avatarUrl: null`.
- Không đăng nhập được (password, Google, quên mật khẩu đều coi như không tồn tại; token
  ký cho nó bị từ chối), không có profile, không follow/nhắn tin được, không hiện trong
  danh sách user của admin.
- Trả lời bình luận AI vẫn được, nhưng không tạo thông báo cho tài khoản này.
