# AI điền form công thức từ caption

Admin không phải gõ tay công thức: AI đọc **caption của bài đăng** (chữ của bài + transcript
từng video) hoặc **đoạn chữ admin dán vào**, rồi trả về bản nháp để điền form
`POST /admin/recipes`. Nguyên liệu được khớp sẵn với danh mục; nguyên liệu chưa có trong danh
mục kèm gợi ý để điền form `POST /admin/ingredients`.

**Không có gì được lưu.** Admin xem lại, sửa, rồi bấm lưu như bình thường.

## `POST /admin/recipes/drafts`

Chỉ admin. Gửi **đúng một** trong hai field:

```json
{ "postId": "11111111-1111-4111-8111-111111111111" }
```

```json
{
  "text": "Đậu hũ sốt cà chua cho 2 người: 300g tàu hũ non cắt khối, 2 quả cà chua..."
}
```

| Field     | Kiểu   | Ghi chú                                                                                                                                       |
| --------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `postId`  | uuid   | Bài đăng bất kỳ (kể cả chưa xuất bản). AI đọc chữ của bài + transcript video.                                                                 |
| `mediaId` | uuid   | Đi kèm `postId`: chỉ đọc transcript của video này (cùng chữ của bài), bỏ qua các video khác. 404 nếu video không thuộc bài hoặc chưa `READY`. |
| `text`    | string | Tối đa `RECIPE_DRAFT_MAX_TEXT_LENGTH` (mặc định 20000) ký tự.                                                                                 |

Response `200`:

```json
{
  "recipe": {
    "title": "Đậu hũ sốt cà chua",
    "description": null,
    "tag": null,
    "servings": 2,
    "prepMinutes": null,
    "cookMinutes": 15,
    "ingredients": [
      {
        "name": "tàu hũ non",
        "quantity": 300,
        "unit": "g",
        "note": "cắt khối",
        "match": { "id": "…", "name": "Đậu hũ non" },
        "suggestion": null
      },
      {
        "name": "nấm đông cô",
        "quantity": null,
        "unit": null,
        "note": null,
        "match": null,
        "suggestion": {
          "name": "nấm đông cô",
          "aliases": ["nấm hương", "shiitake"],
          "groups": [{ "id": "…", "name": "Nấm" }]
        }
      }
    ],
    "steps": [
      "Chiên đậu hũ vàng đều.",
      "Xào cà chua rồi cho đậu vào rim 10 phút."
    ]
  },
  "untranscribedVideos": 0
}
```

- `recipe` là `null` khi nguồn không dạy món nào.
- `ingredients[].name` là tên như caption gọi. `match` là nguyên liệu trong danh mục (AI hiểu
  cả tên gọi khác, ví dụ "tàu hũ" → "Đậu hũ"; backend kiểm lại id và cũng khớp theo tên/tên gọi
  khác). `match` null thì `suggestion` là dữ liệu điền sẵn cho form tạo nguyên liệu:
  `aliases` đã bỏ tên trùng với danh mục, `groups` chỉ gồm nhóm có thật.
- Một nguyên liệu nhắc hai lần chỉ còn một dòng; lượng của lần sau nằm trong `note`
  (ví dụ `"thêm 1 muỗng"`).
- Mọi giá trị đã nằm trong giới hạn của `SaveRecipeDto` (tên 150, đơn vị 30, ghi chú 200,
  bước 1000 ký tự; tối đa 50 nguyên liệu/50 bước; lượng làm tròn 2 chữ số). Field AI không chắc
  là `null`: `servings` null thì giữ giá trị mặc định của form.
- `untranscribedVideos` > 0: còn video đang chờ transcript, bản nháp thiếu phần video nói. Có thể
  thử lại sau khi transcript xong.
- Mỗi lần gọi là một lần gọi AI (chi phí ghi với feature `RECIPE_DRAFT`), thường 5–30 giây.

## Lỗi

| HTTP | `code`                    | Khi nào                                                                                        |
| ---- | ------------------------- | ---------------------------------------------------------------------------------------------- |
| 400  | `BAD_REQUEST`             | Không gửi hoặc gửi cả `postId` lẫn `text`; gửi `mediaId` mà không có `postId`                  |
| 400  | `EMPTY_RECIPE_SOURCE`     | Bài không có chữ hay transcript nào; `details.untranscribedVideos` cho biết còn video đang chờ |
| 400  | `VALIDATION_FAILED`       | `postId` không phải uuid, `text` quá dài, field lạ                                             |
| 404  | `NOT_FOUND`               | Không có bài đăng này, hoặc `mediaId` không phải video sẵn sàng của bài                        |
| 502  | `EXTERNAL_SERVICE_FAILED` | AI lỗi hoặc quá `RECIPE_DRAFT_TIMEOUT_MS`; thử lại                                             |
