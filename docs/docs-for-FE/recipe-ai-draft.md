# AI điền form công thức từ caption

Admin không phải gõ tay công thức: AI đọc **caption của bài đăng** (chữ của bài + transcript
từng video), **đoạn chữ admin dán vào**, hoặc **công thức đang có trên form** để sửa theo yêu cầu
của admin, rồi trả về bản nháp để điền form
`POST /admin/recipes`. Nguyên liệu được khớp sẵn với danh mục; nguyên liệu chưa có trong danh
mục kèm gợi ý để điền form `POST /admin/ingredients`.

**Không có gì được lưu.** Admin xem lại, sửa, rồi bấm lưu như bình thường.

## `POST /admin/recipes/drafts`

Chỉ admin. Gửi **đúng một** nguồn trong ba field `postId`, `text`, `currentRecipe`; có thể kèm
`instruction` với bất kỳ nguồn nào:

```json
{ "postId": "11111111-1111-4111-8111-111111111111" }
```

```json
{
  "text": "Đậu hũ sốt cà chua cho 2 người: 300g tàu hũ non cắt khối, 2 quả cà chua..."
}
```

```json
{
  "currentRecipe": "Tên món: Canh nấm\nKhẩu phần: 2\nNguyên liệu:\n- 200 g nấm rơm\n...",
  "instruction": "Đổi thành 4 người và tính lại Kcal."
}
```

| Field           | Kiểu   | Ghi chú                                                                                                                                                                                                                                          |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `postId`        | uuid   | Bài đăng bất kỳ (kể cả chưa xuất bản). AI đọc chữ của bài + transcript video.                                                                                                                                                                    |
| `mediaId`       | uuid   | Đi kèm `postId`: chỉ đọc transcript của video này (cùng chữ của bài), bỏ qua các video khác. 404 nếu video không thuộc bài hoặc chưa `READY`.                                                                                                    |
| `text`          | string | Tối đa `RECIPE_DRAFT_MAX_TEXT_LENGTH` (mặc định 20000) ký tự.                                                                                                                                                                                    |
| `currentRecipe` | string | Công thức đang có trên form, dạng chữ (tên, khẩu phần, kcal, nguyên liệu, các bước). Tối đa `RECIPE_DRAFT_MAX_TEXT_LENGTH` ký tự. AI sửa trên đó, giữ nguyên phần yêu cầu không nhắc tới.                                                        |
| `instruction`   | string | Yêu cầu của admin, tối đa `RECIPE_DRAFT_MAX_INSTRUCTION_LENGTH` (mặc định 2000) ký tự. **Chỉ field này được AI coi là lệnh**: chữ trong bài, transcript và `currentRecipe` chỉ là dữ liệu, nên đừng ghép yêu cầu vào `text` hay `currentRecipe`. |

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
    "caloriesPerServing": 310,
    "calorieNote": "300 g đậu hũ non ~ 165 kcal, cà chua và dầu ~ 455 kcal, chia 2 suất.",
    "calorieSources": [
      {
        "title": "USDA FoodData Central: Tofu",
        "url": "https://fdc.nal.usda.gov/..."
      }
    ],
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
  "untranscribedVideos": 0,
  "calorieResearch": "DONE"
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
- `caloriesPerServing` là kcal cho 1 suất; `calorieNote` giải thích cách tính (và trả lời câu hỏi
  trong `instruction` nếu có); `calorieSources` là các trang web đã dùng (chỉ `http(s)`, tối đa 6).
- `calorieResearch` cho biết kcal đã được kiểm tra trên web chưa:
  - `DONE`: đã tra web, xem `calorieSources`.
  - `SKIPPED`: không cần tra, ví dụ yêu cầu chỉ đổi tên, đổi chữ, đổi thời gian; hoặc `recipe` null.
    Kcal giữ như trên form (khi gửi `currentRecipe`) hoặc là ước tính của AI.
  - `FAILED`: tra web lỗi hoặc không ra kết quả; `caloriesPerServing` chỉ là ước tính sơ bộ, nên báo
    admin kiểm tra lại.
- `untranscribedVideos` > 0: còn video đang chờ transcript, bản nháp thiếu phần video nói. Có thể
  thử lại sau khi transcript xong.
- Mỗi lần gọi là một lần đọc công thức bằng AI, cộng một lần tra web khi cần kiểm tra kcal (chi phí
  ghi với feature `RECIPE_DRAFT`). Thường 5–30 giây; có tra web thì lâu hơn, tối đa thêm
  `RECIPE_DRAFT_WEB_RESEARCH_TIMEOUT_MS` (mặc định 50 giây).

## Lỗi

| HTTP | `code`                    | Khi nào                                                                                                        |
| ---- | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 400  | `BAD_REQUEST`             | Không gửi nguồn nào hoặc gửi hơn một trong `postId`/`text`/`currentRecipe`; gửi `mediaId` mà không có `postId` |
| 400  | `EMPTY_RECIPE_SOURCE`     | Bài không có chữ hay transcript nào; `details.untranscribedVideos` cho biết còn video đang chờ                 |
| 400  | `VALIDATION_FAILED`       | `postId` không phải uuid, `text`/`currentRecipe`/`instruction` quá dài, field lạ                               |
| 404  | `NOT_FOUND`               | Không có bài đăng này, hoặc `mediaId` không phải video sẵn sàng của bài                                        |
| 502  | `EXTERNAL_SERVICE_FAILED` | AI lỗi hoặc quá `RECIPE_DRAFT_TIMEOUT_MS`; thử lại                                                             |
