# Báo cáo chi phí AI và cơ sở thiết kế gói Vedora Plus / Pro

- Ngày lập và đối chiếu nguồn giá: **10/11/2026**, múi giờ Asia/Bangkok.
- Trạng thái: **báo cáo phân tích và phương án đề xuất để duyệt**.
- Mã nguồn đối chiếu: [BE commit f39de0c](https://github.com/WDP-FA26/vedora-api/commit/f39de0c0476c09252633b8f6f7e53a19aaa9497e).
- Theo dõi: [Báo cáo chi phí OpenRouter và cơ sở thiết kế gói Plus/Pro](https://app.clickup.com/t/z8qgvcdet1).
- Phạm vi thay đổi của tài liệu này: bổ sung báo cáo; **quota, model và hành vi thanh toán trong code chưa được thay đổi theo đề xuất**.

## 1. Kết luận đề xuất

Giữ giá Plus **49.000đ** và Pro **99.000đ**, cùng chu kỳ **30 ngày = 720 giờ**. Điều chỉnh quota khởi đầu theo bảng sau nếu phương án được duyệt:

| Gói  | Giá / chu kỳ | Quota đang có trong code: văn bản / ảnh | Quota đề xuất: văn bản / ảnh |
| ---- | -----------: | --------------------------------------: | ---------------------------: |
| Plus |      49.000đ |                                300 / 10 |                 **150 / 10** |
| Pro  |      99.000đ |                                900 / 40 |                 **300 / 20** |

Cơ sở chính: với ngân sách giả định **80đ/lượt văn bản** và **600đ/ảnh**, người dùng Pro sử dụng hết quota hiện tại sẽ tiêu thụ khoảng **96.000đ tiền AI**, tương đương **96,97% giá bán**. Phần này chưa trả cho hạ tầng, người dùng Free, phí thanh toán, thuế và vận hành. Phương án đề xuất đưa chi phí AI cơ sở về khoảng **36–37% giá bán**; sau dự phòng 20% là khoảng **44%**.

Đây là kết luận từ mô hình dự toán, **chưa phải lợi nhuận thực tế hoặc chi phí trung bình đã đo**. Điều kiện áp dụng là kiểm soát model, độ dài ngữ cảnh, số bước gọi AI và chi phí theo lượt. Nếu tiếp tục dùng router không giới hạn hoặc các lượt dài thường xuyên, giảm quota đơn thuần chưa bảo đảm hiệu quả tài chính.

## 2. Những gì đã biết và chưa biết

| Nhóm                | Nội dung                                                                          | Mức độ chắc chắn                                                              |
| ------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Nguồn công khai     | Đơn giá model, phí mua credit, cách tính reasoning và usage của OpenRouter        | Đã đối chiếu nguồn chính thức tại ngày lập; có thể thay đổi sau đó            |
| Mã nguồn            | Giá/quota mặc định, model mặc định, giới hạn bước, cơ chế chu kỳ                  | Đã đọc tại commit nêu trên                                                    |
| Cấu hình production | Model thực sự được chọn, provider, reranker, phí hóa đơn và tỷ giá thanh toán     | Chưa xác minh từ môi trường production; repo đang đọc không có `.env` thật    |
| Hành vi sử dụng     | Token trung bình, số lần tra tài liệu, tỷ lệ dùng hết quota, retry, ảnh chỉnh sửa | Chưa có mẫu đo đại diện                                                       |
| Giả định phân tích  | Tỷ giá 26.000đ/USD; Standard 5,5%; 80đ/lượt; 600đ/ảnh; dự phòng 20%               | Tham số lập ngân sách do báo cáo chọn, không phải số đo hay giới hạn kỹ thuật |

Không dùng kết quả kiểm thử chức năng thanh toán hoặc Docker để suy ra giá vốn AI. Các kiểm thử đó xác nhận luồng hoạt động, không đo phân bố chi phí sử dụng thực tế.

## 3. Bằng chứng từ mã nguồn Vedora

Các liên kết tương đối dưới đây trỏ tới file trong cùng repo; dùng commit ở đầu báo cáo để xem đúng phiên bản đối chiếu.

| Bằng chứng                 | Vị trí và giá trị đã đọc                                                                                                                                                                                        | Tác động đến chi phí / thiết kế                                                                                               |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Giá và thời hạn mặc định   | [environment.ts](../src/config/environment.ts): `SUBSCRIPTION_PLUS_PRICE_VND=49000`, `SUBSCRIPTION_PRO_PRICE_VND=99000`, `BILLING_DURATION_DAYS=30`                                                             | Giá được quyết định ở BE; 30 ngày là mặc định có thể cấu hình                                                                 |
| Quota hiện tại             | [subscription-policy.ts](../src/subscriptions/subscription-policy.ts): Free 5/0; Plus 300/10; Pro 900/40                                                                                                        | Con số hiện hành khác phương án đề xuất trong báo cáo                                                                         |
| Chu kỳ paid                | [subscriptions.service.ts](../src/subscriptions/subscriptions.service.ts): `capturedAt + durationDays * 86_400_000`                                                                                             | 30 ngày là 720 giờ kể từ capture; không phải tháng lịch                                                                       |
| Model chat mặc định        | [openrouter.ts](../src/ai/openrouter.ts), [environment.ts](../src/config/environment.ts): `openrouter/auto`; `BLOG_AI_MODEL` mặc định rỗng                                                                      | Không thể coi chi phí Flash Lite là giá mặc định đang được bảo đảm                                                            |
| Chọn model blog            | [ai.module.ts](../src/ai/ai.module.ts): `BLOG_AI_MODEL` rỗng thì dùng model chat chung                                                                                                                          | Đổi model chung có thể ảnh hưởng cả planner và blog                                                                           |
| Planner và blog nhiều bước | [meal-planner-chat.service.ts](../src/meal-plan/meal-planner-chat.service.ts), [blog-assistant.service.ts](../src/posts/blogs/ai/blog-assistant.service.ts): tối đa 8 bước/request, 4.000 output token mỗi bước | Một lượt người dùng có thể gồm nhiều model call; 4.000 không phải tổng ngân sách của cả lượt                                  |
| Blog continuation          | [ai-usage.service.ts](../src/subscriptions/ai-usage.service.ts): tối đa 8 request khác nhau trong một logical turn                                                                                              | Continuation hợp lệ không trừ thêm lượt nhưng vẫn có thể phát sinh tiền API                                                   |
| Ngữ cảnh blog              | [blog.dto.ts](../src/posts/dto/blog.dto.ts): bản nháp tối đa 50.000 ký tự; [blog-ai.dto.ts](../src/posts/dto/blog-ai.dto.ts): tối đa 40 message                                                                 | Bản nháp, lịch sử và tool schema làm tăng input; số ký tự không quy đổi cố định sang token                                    |
| Tra cứu tài liệu           | [knowledge-search.service.ts](../src/knowledge/retrieval/knowledge-search.service.ts), [search-knowledge.tool.ts](../src/knowledge/tools/search-knowledge.tool.ts)                                              | Có embedding, rerank và đưa kết quả tra cứu vào ngữ cảnh model; có thể tra lại nhiều lần                                      |
| Cấu hình rerank khác nhau  | [environment.ts](../src/config/environment.ts) mặc định `cohere/rerank-v3.5`; [.env.example](../.env.example) ghi `qwen/qwen3-reranker-8b`                                                                      | Đơn giá Cohere trong báo cáo chỉ áp dụng khi thực sự dùng Cohere                                                              |
| Sinh/chỉnh ảnh             | [blog-image-generator.service.ts](../src/posts/blogs/ai/blog-image-generator.service.ts): Qwen Image 2.1 Turbo mặc định, `maxRetries:1`, moderation, sau đó upload                                              | Giá ảnh phải tính cả trường hợp chỉnh ảnh, retry và lỗi upload sau khi provider đã sinh ảnh                                   |
| Quota khác chi phí         | [ai-request.schema.ts](../src/mongo/schemas/ai-request.schema.ts), [ai-usage.service.ts](../src/subscriptions/ai-usage.service.ts)                                                                              | Lưu trạng thái/lượt và hash, chưa có sổ chi phí USD theo từng provider call; refund quota không đồng nghĩa provider hoàn tiền |

Quy tắc thương mại đã chốt: mọi lần mua thành công đều trả đủ giá gói và bắt đầu chu kỳ/quota mới, kể cả Plus → Pro hoặc mua lại cùng gói. Plus → Pro thu đủ **99.000đ**, có 720 giờ mới; thời gian và quota cũ không cộng dồn. SePay hiện là QR trả trước, chưa tự động trừ tiền định kỳ. Chi tiết ở [hợp đồng subscription](docs-for-FE/subscriptions.md).

## 4. Nguồn giá và quy tắc tính tiền

### 4.1. Quy tắc nền tảng

OpenRouter dùng credit USD và tính tiền inference theo model/provider. Gói Standard thu **5,5% khi mua credit**; Business là **8%**. Phí này được phân bổ vào giá vốn trong báo cáo, không cộng lần thứ hai vào từng request. Streaming không có biểu giá riêng. Thuế nếu phát sinh chưa nằm trong giá niêm yết. [Nguồn: Pricing](https://openrouter.ai/pricing)

`openrouter/auto` tính theo model được router chọn; router không có phụ phí riêng. Có thể dùng `provider.max_price` để lọc mức giá endpoint. Cơ chế này vẫn cần kết hợp giới hạn token/bước vì giá mỗi token thấp không đồng nghĩa tổng request rẻ. [Nguồn: Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router)

Reasoning có thể phát sinh phí dù đặt `exclude:true`. Khi dùng usage của provider, phải kiểm tra reasoning đã nằm trong output tổng hay chưa để tránh cộng trùng. [Nguồn: Reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

### 4.2. Bảng giá đối chiếu ngày 10/11/2026

| Dịch vụ                                | Đơn giá dùng trong phân tích                              | Nguồn chính thức                                                                                                               |
| -------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Gemini 2.5 Flash Lite                  | Input $0,10 / 1 triệu token; output $0,40 / 1 triệu token | [Model pricing](https://openrouter.ai/google/gemini-2.5-flash-lite/pricing), [Models API](https://openrouter.ai/api/v1/models) |
| Gemini 2.5 Flash                       | Input $0,30 / 1 triệu token; output $2,50 / 1 triệu token | [Model page](https://openrouter.ai/google/gemini-2.5-flash), [Models API](https://openrouter.ai/api/v1/models)                 |
| Qwen Image 2.1 Turbo                   | **Từ** $0,0184 / ảnh                                      | [Model page](https://openrouter.ai/qwen/qwen-image-2.1-turbo)                                                                  |
| Cohere Rerank v3.5                     | $0,001 / search                                           | [Model page](https://openrouter.ai/cohere/rerank-v3.5)                                                                         |
| TypeSafe Jev 1.14, moderation mặc định | Input $0,042 / 1 triệu token; output $0                   | [Decisions Models API](https://openrouter.ai/api/v1/models?output_modalities=decisions)                                        |
| Gemini Embedding 2, text               | Input $0,20 / 1 triệu token                               | [Embedding Models API](https://openrouter.ai/api/v1/embeddings/models)                                                         |

Models API trả giá trên **mỗi token**: Flash Lite `prompt=0.0000001`, `completion=0.0000004`; Flash `prompt=0.0000003`, `completion=0.0000025`; Jev `prompt=0.000000042`; embedding text `prompt=0.0000002`. Nhân 1.000.000 để ra đơn vị trong bảng. Chỉ gọi catalogue công khai để đối chiếu; không chạy inference trả phí cho báo cáo.

Nguồn ảnh ghi giá khởi điểm, không chứng minh mọi độ phân giải, tỷ lệ khung hình hoặc tác vụ edit đều có cùng giá. Khi đổi model/provider phải tra và đo lại. Báo cáo không giả định cache hit để giảm giá vốn, và không bao gồm plugin web search hay công cụ trả phí mới.

## 5. Công thức và giả định

Đơn vị `đ` trong báo cáo là VND. Dùng dấu phẩy cho phần thập phân và dấu chấm phân cách hàng nghìn trong các bảng tiếng Việt.

| Ký hiệu           |        Giá trị | Ý nghĩa                                                                             |
| ----------------- | -------------: | ----------------------------------------------------------------------------------- |
| `R`               | 26.000 VND/USD | Tỷ giá **giả định để lập ngân sách**, không phải tỷ giá thị trường đã xác minh      |
| `f`               |          0,055 | Phí mua credit Standard trong kịch bản                                              |
| `K = R × (1 + f)` |         27.430 | Hệ số quy đổi một USD inference sang VND đã phân bổ phí nạp                         |
| `B_text`          |            80đ | Ngân sách cơ sở cho một logical text turn theo kịch bản Flash Lite ở mục 7          |
| `B_image`         |           600đ | Ngân sách cơ sở mỗi ảnh, có điều kiện về kích thước/edit cần kiểm chứng             |
| `s`               |            20% | Dự phòng thêm ở cấp gói cho sai lệch sử dụng; không phải cam kết bao phủ mọi rủi ro |

Với model text có giá `p_in`, `p_out` USD / 1 triệu token:

```text
USD_chat = SUM_tung_model_call((T_in * p_in + T_out * p_out) / 1_000_000)
VND_chat = USD_chat * K

USD_turn = USD_chat + USD_moderation + USD_embedding + USD_rerank
           + chi_phi_provider_khac_cua_turn

Chi_phi_goi_co_so = N_text * B_text + N_image * B_image
Chi_phi_goi_co_du_phong = Chi_phi_goi_co_so * (1 + s)
Ty_le_chi_phi_AI = Chi_phi_AI / Gia_ban
Phan_con_lai = Gia_ban - Chi_phi_AI
```

`T_in` gồm system prompt, tool schema, lịch sử và kết quả tool thực sự được gửi lại trong từng model call. `T_out` là tổng output tính phí, gồm reasoning nếu provider tính trong output. Các model call lặp lại cùng lịch sử vẫn tính input của từng call.

Tiền ảnh tính riêng để tránh cộng lại vào `B_text`. Nếu assistant gọi tool ảnh, lượt đó có thể tiêu thụ cả một lượt text và một lượt image; tiền sinh ảnh chỉ ghi một lần ở image. Chi phí API đã phát sinh ở các lần lỗi hoặc quota được refund vẫn phải đưa vào giá vốn thực tế.

Phép nhân `1,055` giả định chi phí mua credit hiệu dụng đúng bằng 5,5% trên credit. Khi hóa đơn có khoản tối thiểu, thuế, phí ngân hàng hoặc tỷ lệ khác, thay bằng **tổng tiền trả thực tế / số credit nhận được**; không coi công thức này là báo giá thanh toán cuối cùng.

## 6. Ước tính phần model chat mỗi lượt

Các kịch bản sau là **tổng token qua mọi bước và continuation trong một logical turn**, không phải giới hạn đầu vào hoặc số liệu trung bình lấy từ production.

| Kịch bản                     | Tổng input | Tổng output tính phí | Flash Lite, VND | Flash, VND |
| ---------------------------- | ---------: | -------------------: | --------------: | ---------: |
| Ngắn                         |      3.000 |                  600 |           14,81 |      65,83 |
| Thông thường có lịch sử/tool |      8.000 |                2.000 |           43,89 |     202,98 |
| Dài / nhiều bước             |     30.000 |                6.000 |          148,12 |     658,32 |

Ví dụ Flash Lite, kịch bản thông thường:

```text
USD_chat = (8.000 * 0,10 + 2.000 * 0,40) / 1.000.000
         = 0,0016 USD
VND_chat = 0,0016 * 26.000 * 1,055 = 43,888 VND
```

Đổi sang Flash với cùng token sẽ tốn `0,0074 USD × 27.430 = 202,982đ`, cao khoảng 4,63 lần. Vì thế mức ngân sách 80đ/lượt của báo cáo **không áp dụng mặc nhiên cho Flash hoặc model bất kỳ do Auto Router chọn**.

## 7. Vì sao chọn ngân sách 80đ/lượt và 600đ/ảnh?

### 7.1. Một lượt text có một lần tra tài liệu

Kịch bản minh họa dùng Flash Lite, 8.000 input / 2.000 output tổng cộng; một search dùng Cohere; tổng moderation 1.000 token; embedding truy vấn 200 token:

| Thành phần         | Phép tính                                | VND đã phân bổ phí nạp |
| ------------------ | ---------------------------------------- | ---------------------: |
| Model chat         | Theo mục 6                               |                 43,888 |
| Một rerank search  | $0,001 × 27.430                          |                 27,430 |
| Moderation Jev     | 1.000 × $0,042 / 1.000.000 × 27.430      |                  1,152 |
| Embedding truy vấn | 200 × $0,20 / 1.000.000 × 27.430         |                  1,097 |
| Tổng minh họa      | Cộng bốn thành phần                      |             **73,567** |
| Ngân sách làm tròn | Dành thêm khoảng 6,433đ cho sai lệch nhỏ |             **80,000** |

Các lượng token trên là giả định, không phải kết quả đếm prompt thật. Nhiều lần tra cứu, chính sách moderation dài, context lớn hoặc retry có thể vượt 80đ. Nếu reranker production là Qwen, cần thay đơn giá tương ứng; không gán giá Cohere cho Qwen.

### 7.2. Một ảnh

```text
Gia_khoi_diem_anh = 0,0184 * 26.000 * 1,055 = 504,712đ
Ngan_sach_anh = 600đ
```

Khoảng chênh 95,288đ là đệm dự toán nhỏ, chưa đủ để kết luận bao phủ ảnh lớn, edit có input ảnh, nhiều lần tạo lại hoặc lỗi storage. Không có kích thước pixel cố định cho mọi trường hợp trong code hiện tại. Cần đo generate/edit riêng và chốt kích thước trước khi xem 600đ là ngân sách vận hành đáng tin cậy.

## 8. So sánh quota hiện tại và phương án đề xuất

Giả định khách dùng **100% cả hai loại quota**, giá text 80đ, ảnh 600đ; không lấy việc khách ít dùng để làm điều kiện có lãi.

| Phương án     | Giá bán | Text / ảnh | AI cơ sở | AI / giá bán | AI + dự phòng 20% | Phần còn lại sau AI và dự phòng |
| ------------- | ------: | ---------: | -------: | -----------: | ----------------: | ------------------------------: |
| Plus hiện tại | 49.000đ |   300 / 10 |  30.000đ |       61,22% |           36.000đ |                         13.000đ |
| Pro hiện tại  | 99.000đ |   900 / 40 |  96.000đ |       96,97% |          115.200đ |                    **-16.200đ** |
| Plus đề xuất  | 49.000đ |   150 / 10 |  18.000đ |       36,73% |           21.600đ |                         27.400đ |
| Pro đề xuất   | 99.000đ |   300 / 20 |  36.000đ |       36,36% |           43.200đ |                         55.800đ |

Ví dụ Pro hiện tại: `900 × 80 + 40 × 600 = 96.000đ`. Pro đề xuất: `300 × 80 + 20 × 600 = 36.000đ`.

**Phần còn lại không phải lợi nhuận ròng.** Nó còn phải trả database/Redis/Qdrant/API, lưu trữ/CDN, email, thanh toán, hỗ trợ, thuế, chi phí Free/guest, nội dung/indexing/moderation dùng chung và chi phí cố định. Chưa có số liệu để tính lợi nhuận ròng hoặc khẳng định mức giá tối ưu theo thị trường.

Mục tiêu quản trị được chọn trong báo cáo là giữ AI cơ sở quanh **40% giá bán hoặc thấp hơn** khi dùng hết quota. Đây là tiêu chí nội bộ đề xuất, không phải chuẩn bắt buộc của ngành. Sau đệm 20%, phương án mới còn khoảng 56% giá bán để phân bổ cho các khoản ngoài AI; vẫn cần lập ngân sách thực tế.

## 9. Độ nhạy và ngưỡng chịu chi phí

### 9.1. Khi tiền text tăng

Giữ ảnh 600đ, dùng hết quota đề xuất; chưa cộng dự phòng 20%:

| Chi phí text / lượt | Plus 150 text + 10 ảnh | Pro 300 text + 20 ảnh |
| ------------------- | ---------------------: | --------------------: |
| 40đ                 |                12.000đ |               24.000đ |
| 80đ                 |                18.000đ |               36.000đ |
| 160đ                |                30.000đ |               60.000đ |
| 240đ                |                42.000đ |               84.000đ |

Ở kịch bản Flash thông thường có cùng một search/moderation/embedding như mục 7, một lượt khoảng `202,982 + 27,430 + 1,152 + 1,097 = 232,661đ`. Phương án Plus/Pro mới sẽ tốn khoảng **40.899đ / 81.798đ** trước dự phòng và hạ tầng. Vì vậy lựa chọn model là điều kiện của quyết định, không thể chỉ giảm quota rồi giữ router không kiểm soát.

Nếu ảnh thực tế là 1.200đ thay vì 600đ, với text 80đ thì Plus/Pro đề xuất lần lượt thành **24.000đ / 48.000đ**, tăng 6.000đ / 12.000đ mỗi chu kỳ. Đây là kịch bản kiểm tra độ nhạy, không phải giá ảnh đã quan sát.

### 9.2. Ngưỡng tiền text theo mục tiêu AI cơ sở 40%

```text
Text_cost_target_max = (0,40 * Gia_ban - N_image * 600) / N_text
```

| Phương án              | Giá text trung bình tối đa để AI cơ sở ≤ 40% giá bán |
| ---------------------- | ---------------------------------------------------: |
| Plus hiện tại 300 / 10 |                                          45,33đ/lượt |
| Pro hiện tại 900 / 40  |                                          17,33đ/lượt |
| Plus đề xuất 150 / 10  |                                          90,67đ/lượt |
| Pro đề xuất 300 / 20   |                                          92,00đ/lượt |

Ngưỡng 17,33đ của Pro hiện tại thấp hơn cả kịch bản text có một lần rerank Cohere giá khoảng 27,43đ, chưa tính model chat. Đó là bằng chứng định lượng cho việc quota 900/40 thiếu dư địa trong trường hợp tra cứu thường xuyên.

Đây là ngưỡng mục tiêu, không phải hòa vốn. Hòa vốn chỉ xét AI có dự phòng, vẫn chưa trả hạ tầng, xảy ra khi `B_text = (Gia_ban / 1,20 - N_image × 600) / N_text`. Ngưỡng tương ứng là **116,11đ / 65,00đ** cho Plus/Pro hiện tại và **232,22đ / 235,00đ** cho Plus/Pro đề xuất. Chi phí thực tế phải thấp hơn nữa để còn trả các khoản ngoài AI.

### 9.3. Trợ giá Free và guest

Free trong code có 5 lượt/ngày. Trong một khoảng 30 ngày có thể dùng khoảng 150 lượt; ở giả định 80đ/lượt là **12.000đ/người**, chưa gồm guest demo. Đây là dự toán theo ngày, không phải subscription quota 150/tháng; số bucket ngày đi qua có thể khác khi tính một khoảng trượt bắt đầu giữa ngày.

Ví dụ 1.000 người Free dùng đủ 150 lượt minh họa sẽ tạo 12 triệu đồng tiền AI. Cần lập ngân sách cấp hệ thống và chống lạm dụng; không giả định toàn bộ doanh thu paid đều dành riêng cho phục vụ paid.

## 10. Cơ sở chọn hai gói và giới hạn của quyết định

| Quyết định đề xuất                             | Bằng chứng / lý do                                                              | Điều kiện hoặc giới hạn                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Giữ 49.000đ / 99.000đ và 720 giờ               | Phù hợp giá và chính sách người dùng đã chốt                                    | Chưa có khảo sát willingness-to-pay hay thử nghiệm chuyển đổi để chứng minh tối ưu thị trường                    |
| Plus 150 text / 10 ảnh                         | 18.000đ cơ sở, 21.600đ có dự phòng; còn 27.400đ trước các chi phí khác          | Cần giữ chi phí text/ảnh trong ngân sách giả định                                                                |
| Pro 300 text / 20 ảnh                          | Quyền sử dụng gấp đôi Plus, giá gần gấp đôi; 36.000đ cơ sở, 43.200đ có dự phòng | Không hứa model đắt hơn cho Pro nếu chưa tính lại giá vốn                                                        |
| Dùng Flash Lite làm model tham chiếu ngân sách | Đơn giá công khai cho thấy thấp hơn Flash đáng kể với cùng token                | Chưa chứng minh chất lượng tiếng Việt, dinh dưỡng, tool calling; cần bộ đánh giá riêng trước khi chọn production |
| Không mở unlimited                             | Nhiều bước, continuation và context khiến mỗi lượt có giá khác nhau             | Phải thêm tổng ngân sách theo lượt/người/ngày ở giai đoạn triển khai                                             |
| Xem lại quota sau khi có dữ liệu               | Hiện chưa đo mean/P95, tỷ lệ RAG và ảnh edit                                    | Không lấy dự toán 80đ/600đ làm số liệu usage thật                                                                |

## 11. Việc cần làm trước khi áp dụng và đo sau triển khai

Đây là danh sách công việc tiếp theo, **chưa được thực hiện bởi thay đổi tài liệu này**:

1. Chọn model/provider hoặc allowlist có giới hạn giá; kiểm chứng chất lượng trên câu hỏi dinh dưỡng, tạo thực đơn và chỉnh blog tiếng Việt. Nếu có fallback, mọi fallback phải nằm trong ngân sách được duyệt.
2. Giới hạn tổng input/context, tổng output, tổng số model call và số lần search cho cả logical turn, bao gồm continuation. Giới hạn 4.000 token mỗi bước hiện tại chưa thay thế các giới hạn này.
3. Chốt kích thước ảnh, tham số generate/edit và chính sách retry. Đo giá edit có input ảnh riêng.
4. Ghi chi phí của mọi provider call, kể cả thất bại/abort/refund quota nhưng đã bị tính tiền. Liên kết bằng logical turn ID, request/step ID và provider generation ID; phân loại text, moderation, embedding, rerank và image để tránh bỏ sót hoặc cộng trùng.
5. Ưu tiên `usage.cost`/dữ liệu generation thực trả; lưu model/provider thật, input/output/reasoning/cache, trạng thái, tiền USD và giá quy đổi. Không cần lưu raw prompt để tính giá vốn. OpenRouter có usage tự động và tra lại qua generation ID. [Nguồn: Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
6. Đo riêng planner, blog, generate ảnh, edit ảnh và nhóm Free/guest. `Mean = tổng tiền mọi call / số logical turn phục vụ`; báo thêm tiền trên lượt thành công, tỷ lệ lỗi, P50/P95/P99. Quota refund không được làm mất chi phí khỏi tử số.
7. Đề xuất giai đoạn pilot ít nhất 1.000 lượt text và 100 ảnh, có cả RAG, nhiều bước, draft dài, retry và edit. Đây là mức khởi đầu thực dụng, không bảo đảm đại diện thống kê. Thu thêm dữ liệu khi nhóm tác vụ quan trọng còn ít mẫu.
8. Đối soát hóa đơn/credit thực trả với sổ usage; thay tỷ giá, phí, chi phí hạ tầng và ngân sách Free bằng số thật. Chỉ tăng quota khi kiểm tra dùng hết quota và kịch bản chi phí cao vẫn còn đủ nguồn lực vận hành.
9. Khi được duyệt, cập nhật policy, catalogue và FE mô tả nhất quán. Intent đã mua có snapshot quyền lợi phải giữ nguyên; không âm thầm giảm quota của chu kỳ đã thanh toán. Cần thiết kế version/chuyển tiếp cho pending intent và các lần mua mới.

## 12. Tái lập phép tính

Đoạn Python sau dùng thư viện chuẩn, chỉ tính toán; không gọi API và không phát sinh inference. Dấu chấm trong code là dấu thập phân theo Python.

```python
from decimal import Decimal as D

fx, fee = D("26000"), D("0.055")
k = fx * (1 + fee)

def text_vnd(t_in, t_out, p_in, p_out):
    return (D(t_in) * D(p_in) + D(t_out) * D(p_out)) / D(1000000) * k

assert k == D("27430")
assert 30 * 24 == 720
for label, t_in, t_out in [
    ("short", 3000, 600),
    ("typical", 8000, 2000),
    ("long", 30000, 6000),
]:
    print(label, text_vnd(t_in, t_out, "0.10", "0.40"),
          text_vnd(t_in, t_out, "0.30", "2.50"))

chat = text_vnd(8000, 2000, "0.10", "0.40")
rerank = D("0.001") * k
moderation = D(1000) * D("0.042") / D(1000000) * k
embedding = D(200) * D("0.20") / D(1000000) * k
assert chat == D("43.888")
assert rerank == D("27.430")
assert chat + rerank + moderation + embedding == D("73.567260")
assert D("0.0184") * k == D("504.7120")

plans = [
    ("Plus-current", 49000, 300, 10, 30000, 36000),
    ("Pro-current", 99000, 900, 40, 96000, 115200),
    ("Plus-proposed", 49000, 150, 10, 18000, 21600),
    ("Pro-proposed", 99000, 300, 20, 36000, 43200),
]
for name, price, n_text, n_image, expected, expected_buffered in plans:
    base = D(n_text) * 80 + D(n_image) * 600
    buffered = base * D("1.20")
    assert base == expected and buffered == expected_buffered
    target = (D("0.40") * price - n_image * 600) / n_text
    ai_only_break_even = (D(price) / D("1.20") - n_image * 600) / n_text
    print(name, "base", base, "buffered", buffered,
          "AI_percent", base / price * 100, "remaining", price - buffered,
          "text_target", target, "AI_only_break_even", ai_only_break_even)

for unit_text in (40, 80, 160, 240):
    print("sensitivity", unit_text, 150 * unit_text + 10 * 600,
          300 * unit_text + 20 * 600)

flash_turn = text_vnd(8000, 2000, "0.30", "2.50") + rerank + moderation + embedding
print("Flash-with-search", flash_turn,
      "Plus", flash_turn * 150 + 10 * 600,
      "Pro", flash_turn * 300 + 20 * 600)
assert 150 * 80 + 10 * 1200 == 24000
assert 300 * 80 + 20 * 1200 == 48000
```

Giá và tỷ giá thay đổi thì thay tham số và tính lại toàn bộ bảng. Mọi quyết định mở bán cuối cùng cần ghép kết quả này với chất lượng model, hóa đơn thực tế, chi phí phục vụ Free và chi phí vận hành của Vedora.
