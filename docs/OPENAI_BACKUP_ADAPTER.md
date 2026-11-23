# OpenAI trực tiếp làm phương án dự phòng

BE chọn provider một lần khi khởi động. Mặc định vẫn là OpenRouter. Khi OpenRouter gặp sự cố, đổi `AI_PROVIDER=openai` và tạo lại process/container API. FE tiếp tục gọi cùng các endpoint hiện có.

Đây là chuyển chủ động bằng env, không phải tự động failover. Request đang chạy không được phát lại qua provider khác; các thao tác tool, đăng bài và lưu thực đơn không bị adapter tự chạy lần hai.

## Cấu hình để chuyển trước buổi bảo vệ

Thêm key vào secret/env **của BE**, không đưa vào Git hoặc biến `NEXT_PUBLIC_*`:

```dotenv
AI_PROVIDER=openai
OPENAI_API_KEY=<key OpenAI của bạn>
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-6-luna
OPENAI_DECISION_MODEL=gpt-6-luna
```

Chỉ provider đang chọn phải có key. Có thể giữ cả `OPENROUTER_API_KEY` và `OPENAI_API_KEY` để đổi qua lại; không dùng key của provider này để gọi provider kia. Model ID OpenAI là `gpt-6-luna`, không có tiền tố `openai/` như tên model trên OpenRouter.

Sau khi triển khai code adapter lần đầu bằng image mới, đổi env rồi tạo lại container:

```sh
docker compose up -d --force-recreate api
```

Nếu cần build image từ source của nhánh này:

```sh
docker compose up -d --build api
```

`docker compose restart` đơn thuần không đưa env mới từ file vào container đã tạo. Khi chạy qua terminal, dừng và chạy lại process NestJS. Trên dịch vụ hosting, cập nhật env rồi redeploy/restart theo cách dịch vụ đó áp dụng env.

Quay về OpenRouter bằng `AI_PROVIDER=openrouter`, giữ key/model OpenRouter cũ và tạo lại API. Không cần đổi FE hoặc xóa dữ liệu MongoDB.

## Các biến tùy chọn

| Biến | Mặc định | Mục đích |
| --- | --- | --- |
| `AI_PROVIDER` | `openrouter` | `openrouter` hoặc `openai` |
| `OPENAI_API_KEY` | rỗng | Bắt buộc khi chọn `openai` |
| `OPENAI_API_BASE_URL` | `https://api.openai.com/v1` | Endpoint trực tiếp; chỉ đổi cho proxy/test đáng tin cậy |
| `OPENAI_MODEL` | `gpt-6-luna` | Chat, planner, tóm tắt, recipe draft, OCR và dịch |
| `OPENAI_BLOG_MODEL` | rỗng | Model riêng cho blog; rỗng dùng `OPENAI_MODEL` |
| `OPENAI_DECISION_MODEL` | `gpt-6-luna` | Guardrails và phân loại nội dung qua native Decisions API |
| `OPENAI_EVIDENCE_MODEL` | rỗng | Reviewer/bằng chứng kiểm duyệt; rỗng dùng `OPENAI_MODEL` |
| `OPENAI_IMAGE_MODEL` | `gpt-image-1` | Tạo/sửa ảnh blog |
| `OPENAI_TRANSCRIPTION_MODEL` | `whisper-1` | Phụ đề có timestamp theo từ |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Adapter text embedding; không thay thế vector Gemini trong index đang có |

Model gọi trực tiếp phụ thuộc quyền model và hạn mức của OpenAI project. Test key, quyền model và số dư của project trước buổi bảo vệ; adapter không tự nạp tiền hoặc dùng tài khoản ChatGPT thay cho API.

## Phạm vi và khác biệt

- **Chat/stream/tool/JSON:** dùng Responses API. `store:false`; yêu cầu encrypted reasoning content để các lượt tool có thể tiếp tục trong chế độ không lưu response. Các guard, quota, consent tìm web và quyền thực thi tool của ứng dụng vẫn được áp dụng.
- **Guardrails/kiểm duyệt:** gọi `/v1/decisions` trực tiếp với choice policy và ảnh JPEG inline. Dùng phân bố xác suất từ API, không yêu cầu chat model tự đoán confidence. Thiếu câu trả lời, thiếu nhãn, trùng nhãn hoặc phân bố không hợp lệ làm request thất bại. Provider từ chối đọc nội dung đi vào luồng giữ/từ chối hiện có. Threshold và `MODERATION_MODE` giữ chính sách đang cấu hình; không bảo đảm hai provider luôn cho cùng kết quả.
- **Tìm web:** đổi server tool từ `openrouter.web_search` sang `openai.web_search`. Quyền cho phép tìm web của planner không thay đổi.
- **Ảnh:** dùng OpenAI Image API. Kích thước native là 1024×1024, 1024×1536 hoặc 1536×1024; lựa chọn ngang 4:3/16:9 dùng kích thước ngang native, không cam kết đúng tỷ lệ của model OpenRouter cũ. Sửa ảnh vẫn kiểm tra quyền sở hữu file.
- **Phụ đề:** gửi multipart MP3 đến `/audio/transcriptions`, dùng `verbose_json` và timestamp theo từ, giữ cách ghép lại timeline audio hiện có. Model thay cho `whisper-1` cần hỗ trợ các định dạng/timestamp này.
- **OCR:** PDF được chuyển vào model OpenAI qua Responses để lấy văn bản theo trang; không gọi plugin `file-parser` riêng của OpenRouter. Bộ trích xuất PDF và cờ kiểm tra chất lượng hiện có vẫn được dùng.

## RAG: tránh trộn hai không gian vector

Khi `AI_PROVIDER=openai`, knowledge, bài viết và menu dùng **BM25 từ khóa** trên collection Qdrant hiện có. Không tạo query vector OpenAI để so với vector Gemini, không gọi reranker OpenRouter, và không nhúng ảnh vào model text embedding.

Bài/menu/tài liệu mới được index phần từ khóa; knowledge không tạo vector cho hình ảnh trong chế độ dự phòng. Dữ liệu cũ vẫn tìm được theo từ khóa, nhưng khả năng tìm theo ý nghĩa/hình ảnh giảm so với chế độ đầy đủ. Đây không phải migration vector sang OpenAI.

Khi quay về OpenRouter, các phần tử chỉ được index trong chế độ dự phòng vẫn có kết quả BM25. Muốn có dense vector cho chúng cần reindex bằng model gốc. Không xóa collection hoặc reindex toàn bộ bằng OpenAI để chuyển tạm trước buổi bảo vệ.

## Chi phí và an toàn dữ liệu

`ai_cost_calls.gateway` phân biệt `openrouter` và `openai`; các bản ghi cũ mặc định OpenRouter. Native OpenAI usage có token nhưng thường không có số USD cho từng response. `costUsd` giữ `null` khi không có số tiền, không ghi thành miễn phí và không tính giá phỏng đoán.

Không gửi response ID của OpenAI vào chức năng đối soát generation của OpenRouter: thao tác đó trả 409 rõ nguyên nhân. Đối chiếu chi phí OpenAI qua trang usage/billing của OpenAI project. Log telemetry không lưu key, prompt hay câu trả lời.

## Kiểm thử

```sh
npm run build
npm run lint
npm run test:openai
```

- `test/unit/ai/openai-provider.spec.ts`: request Responses, stream, tool call, JSON schema, native web tool, text embedding, ảnh, native Decisions, validation, từ chối và hủy.
- `test/unit/ai/openai-services.spec.ts`: multipart audio/timeline, OCR, bỏ rerank và truy xuất BM25 không gọi dense embeddings.
- Kiểm thử telemetry và index bài: không lưu bí mật, không bịa giá, không viết dense vector khác model.
- `test/provider/openai-adapter.spec.ts`: ứng dụng Nest thật + Mongo riêng, provider HTTP giả lập; chạy không có OpenRouter key, đăng bài, guardrail, guest SSE và đối soát.
- Production Docker image được smoke test với Mongo/Qdrant thật, provider/captcha cục bộ giả lập: không gọi OpenAI/OpenRouter trả phí. Điều này kiểm tra wiring và protocol; chưa xác nhận quyền model/hạn mức của key production của người dùng.

Tại thời điểm triển khai, `test/unit/config/config-files.spec.ts` có một test hash prompt thất bại giống hệt trên `main` nguyên bản `741b25e`. Không sửa prompt hoặc fixture của phần đó trong nhánh adapter.

## Nguồn API

- [OpenAI Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)
- [OpenAI Decisions: choice và phân bố xác suất](https://developers.openai.com/api/docs/guides/decisions)
- [GPT-6 Luna: API và công cụ được hỗ trợ](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [OpenAI provider của AI SDK](https://ai-sdk.dev/providers/ai-sdk-providers/openai)

Dependency OpenAI provider được pin `4.0.70` cho tương thích AI SDK đang dùng trong repo. Native Decisions đi qua adapter HTTP nhỏ thay vì helper evaluation bằng chat của phiên bản SDK này.
