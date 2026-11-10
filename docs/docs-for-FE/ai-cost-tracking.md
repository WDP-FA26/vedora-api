# Theo dõi chi phí AI thực tế

Tính năng ghi nhận chi phí USD **OpenRouter báo về**, thay vì nhân số lượt với một mức giá giả định. FE quản trị ở `/admin/ai-costs`. Các API bên dưới đều yêu cầu tài khoản ADMIN đang hoạt động và trả `Cache-Control: private, no-store`.

Không đổi model, quota, giới hạn token, chính sách subscription hay thêm background job. Công việc giới hạn token trên ClickUp vẫn có phạm vi riêng. [Báo cáo thiết kế gói](../SUBSCRIPTION_COST_REPORT.md) tiếp tục là dự toán; phải có dữ liệu thực tế sau triển khai để đánh giá lại.

## Ghi nhận tại provider transport

- Collection `ai_cost_calls`: một bản ghi cho mỗi HTTP attempt đến OpenRouter qua các client đã tích hợp. Retry của SDK tạo attempt riêng; các bước/continuation được liên kết bằng `turnId`, mỗi HTTP request vào Vedora có `executionId` riêng.
- Bao phủ client chat mặc định/blog, evaluation/moderation, embedding mặc định/post search, image generate/edit, REST knowledge embedding/OCR/rerank và transcription. SDK Decisions dùng `/api/alpha/decisions`, các API còn lại chủ yếu dùng `/api/v1/*`.
- Lưu model yêu cầu, model/provider thực sự được trả về nếu có, generation ID, thời gian, trạng thái, input/output/reasoning/cache, USD và nguồn chi phí. Không lưu prompt, output hội thoại, ảnh/base64, header Authorization hoặc API key.
- `costUsd` lưu Decimal128. `null` nghĩa là chưa biết; `0` chỉ khi provider báo số 0. Không suy giá từ bảng niêm yết, không lấy `upstream_inference_cost` cộng vào `usage.cost` lần nữa. Reasoning/cache là chi tiết token, không cộng lặp vào output/input tổng.
- Khi có generation ID và chi phí, unique `chargeKey` ngăn cộng trùng cùng generation. Attempt trùng vẫn giữ lại với `duplicateCharge:true`, chi phí rỗng; không coi là một khoản phí chưa biết. Turn chỉ gồm duplicate không được đưa vào mẫu mean/P95 như một lượt miễn phí.
- `PENDING`: đã ghi trước khi gửi provider. `SUCCEEDED`, `FAILED`, `ABORTED`: trạng thái đọc HTTP response/stream, không phải trạng thái lưu bài/ảnh hay quota. Một call provider thành công vẫn bị tính tiền nếu upload sau đó lỗi hoặc quota được refund.

Ngữ cảnh HTTP dùng AsyncLocalStorage. Planner dùng ID user message; blog dùng ID user message + chat session để nối các continuation, và luôn gắn user/feature. Không gửi định danh nội bộ này sang provider. Guest và các tác vụ không có logical message ID dùng ID thực thi riêng; không mặc nhiên coi chúng là cùng một lượt. Các lần gọi ngoài ngữ cảnh HTTP có feature dự phòng và turn riêng, nên tác vụ nền/indexing không có đầy đủ liên kết lượt người dùng.

Transport chuyển nguyên byte response về SDK và đọc metadata trong quá trình tiêu thụ body. Buffer JSON giới hạn 16 Mi ký tự; dòng SSE giới hạn 1 Mi ký tự. Response quá lớn/không đúng dạng sẽ không giữ nội dung và có thể thiếu metadata; chi phí vẫn để chưa biết. Phân tích JSON chỉ ở mức metadata allowlist, không ghi payload vào DB/log.

## API

### `GET /admin/ai-costs`

Query tùy chọn:

| Trường       | Quy tắc                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `from`, `to` | Cần cả hai hoặc không có; YYYY-MM-DD hợp lệ, tăng dần, tối đa 90 ngày tính cả hai đầu                              |
| `feature`    | `MEAL_PLAN_CHAT`, `BLOG_CHAT`, `GUEST_CHAT`, `CONTENT_MODERATION`, `KNOWLEDGE`, `POSTS`, `TRANSCRIPTION`, `SYSTEM` |
| `model`      | So khớp chính xác resolved model; nếu chưa biết thì requested model; tối đa 200 ký tự                              |

Mặc định 30 ngày gần nhất theo Asia/Bangkok (UTC+7). Lọc theo thời điểm bắt đầu attempt, từ đầu ngày `from` đến trước đầu ngày kế tiếp `to`. Trường query lạ bị từ chối.

Response gồm:

- `currency:"USD"`, `scope:"MATCHED_CALLS"`, `generatedAt`, `range`.
- `summary`: tổng attempt, known/unknown/duplicate/pending/failed, `knownSpendUsd`, các token tổng và `unknownTokenCalls`; số turn, turn đủ dữ liệu, mean và P95 của turn đủ dữ liệu.
- `daily`: tổng theo ngày UTC+7; không tạo cột cho ngày chưa có attempt.
- `groups`: tối đa 100 nhóm model/feature/operation có chi phí đã biết cao nhất; `groupsLimit:100`.
- `expensiveTurns`: tối đa 20 turn có tổng chi phí đã biết cao nhất, kèm số call thiếu chi phí và pending.

Các giá trị tiền là **chuỗi số USD**, không phải float JSON. Token là số nguyên hoặc tổng số token đã biết. `meanKnownTurnUsd`/`p95KnownTurnUsd` là `null` khi chưa có lượt đủ dữ liệu. P95 dùng nearest-rank: phần tử thứ `ceil(0,95 × N)` của dãy chi phí tăng dần, không dùng phép xấp xỉ percentile.

**Giới hạn bộ lọc:** tổng của turn chỉ gồm các call nằm trong bộ lọc hiện tại. Lọc một model hoặc cắt ngày giữa một turn có thể chỉ lấy một phần chi phí turn. “Đủ dữ liệu” chỉ có nghĩa mọi call khớp bộ lọc của turn đều có phí và không còn pending, không khẳng định lịch sử toàn bộ turn đã được ghi nhận. Mean/P95 bỏ qua turn chưa đủ phí, nên có thể thiên lệch; luôn xem coverage cùng các con số này. Hai aggregation báo cáo chạy gần nhau, không phải một snapshot giao dịch của toàn bộ hệ thống.

Ví dụ các trường summary chính:

```json
{
  "knownSpendUsd": "0.00505",
  "calls": 4,
  "knownCalls": 4,
  "unknownCalls": 0,
  "duplicateCalls": 0,
  "pendingCalls": 0,
  "turns": 1,
  "fullyPricedTurns": 1,
  "meanKnownTurnUsd": "0.00505",
  "p95KnownTurnUsd": "0.00505"
}
```

Đây là dữ liệu fixture minh họa, không phải kết quả đo giá vốn production.

### `GET /admin/ai-costs/calls`

Nhận cùng bộ lọc và thêm `page` (mặc định 1, tối đa 100.000), `limit` (mặc định 50, tối đa 100). Trả `{ items, total, page, limit }`, mới nhất trước. Mỗi item có `id`, `turnId`, `executionId`, `userId`, model/provider/generation, trạng thái, token, `costUsd`, `costSource`, `duplicateCharge`, thời điểm bắt đầu/kết thúc/đối soát.

### `GET /admin/ai-costs/export`

Cùng bộ lọc báo cáo; tải CSV UTF-8 BOM với tối đa 10.000 attempt. Vượt giới hạn trả 400, yêu cầu thu hẹp bộ lọc; không âm thầm cắt dữ liệu. Chi phí chưa biết để ô trống. Chuỗi bắt đầu bằng ký tự công thức spreadsheet được escape; mọi ô được quote. FE gửi Bearer bằng fetch rồi tải blob, không đưa token vào URL.

### `POST /admin/ai-costs/calls/:id/reconcile`

Tra lại generation ID đã lưu bằng API generation của OpenRouter; không chạy inference. Dùng API key BE, không nhận URL hoặc generation ID tùy ý từ FE. Call đã có phí hoặc duplicate trả lại dữ liệu hiện tại. Call thiếu generation ID, hoặc còn PENDING chưa đủ 15 phút, trả 409. Provider lỗi/chưa có phí/ID không khớp trả 503.

Thành công lấy `total_cost`, lưu `costSource:"GENERATION"` và `reconciledAt`; không sửa quota hay suy diễn kết quả nghiệp vụ. Giữ trạng thái stream cũ, kể cả ABORTED/PENDING; đối soát được tiền không chứng minh request đã hoàn tất. Không có cron/worker tự tra lại; Admin chủ động bấm “Lấy chi phí”. Nút có thể nhận 409 nếu attempt còn đang chạy.

## Những gì con số này chưa bao gồm

1. Lịch sử trước khi triển khai hoặc call không đi qua transport. Không backfill giá giả định cho dữ liệu cũ.
2. Phí nạp credit, thuế, tỷ giá/ngân hàng, hạ tầng, storage, email và vận hành. Nếu BYOK, chi phí upstream trả riêng cần đối soát riêng; trường USD ở đây phản ánh khoản OpenRouter báo.
3. Response mất kết nối trước khi có metadata hoặc body chưa được SDK tiêu thụ hết. Các record này có thể pending/unknown; không tự coi là miễn phí hoặc thất bại không mất tiền.
4. Ghi DB lỗi: AI vẫn tiếp tục để không làm hỏng tính năng đang dùng; log `AI_COST_WRITE_FAILED` báo mất coverage. Nếu insert đầu thất bại, dashboard không thể đếm record chưa từng được ghi. Cần theo dõi log và đối soát OpenRouter Activity trước khi khẳng định chi phí đầy đủ.
5. Model/provider chưa trả đầy đủ token. Token tổng trên dashboard chỉ cộng phần đã biết; `unknownTokenCalls` phản ánh thiếu input/output. Phí có thể biết ngay cả khi token chưa biết.

## Kiểm chứng và triển khai

- MongoDB tự tạo collection/index qua đăng ký model hiện có. Không migration tài chính, không xóa lịch sử quota.
- Không thêm biến môi trường bắt buộc hoặc package. Sử dụng OPENROUTER_API_KEY hiện tại.
- Deploy BE và FE cùng contract mới. Kiểm tra bằng Admin, xác nhận tài khoản USER bị từ chối cả báo cáo, chi tiết, CSV và đối soát.
- Kiểm thử tự động dùng provider giả lập và MongoDB fixture, không phát sinh phí AI thật. Docker smoke chạy SDK thật qua transport với response fixture: nhiều bước chat + moderation + embedding cùng turn; unknown rồi reconcile; phí ảnh còn được lưu khi storage lỗi và quota được refund.
- Build/lint/typecheck và kiểm thử API không thay thế kiểm chứng giao diện trong trình duyệt hoặc đối soát hóa đơn thực. Sau deploy cần pilot có kiểm soát để thu số liệu thật rồi đánh giá lại quota Plus/Pro.

Nguồn hợp đồng provider: [Usage Accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [Reasoning Tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens). Chi phí lấy từ response/generation thực trả, không từ công thức dự toán trong báo cáo giá gói.
