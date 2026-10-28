# Trợ lý AI soạn blog (chat + editor tools + tạo ảnh)

Base URL: `/api/v1`. Trang soạn blog có editor Markdown bên trái và khung chat
bên phải. Agent không trả đoạn văn để người dùng tự chép: nó gọi **editor tool**
chạy ở FE để đề xuất thay đổi; người dùng Accept/Reject từng thay đổi. Backend
không lưu gì vào blog. Người dùng vẫn lưu bài bằng `PATCH /blogs/:id` như cũ.

Dùng AI SDK v7 (`ai`, `@ai-sdk/react`), cùng giao thức UI message stream với
`/meal-plan/chat`. Gợi ý UI: shadcn AI Elements (`Conversation`, `Message`,
`Tool`, `Confirmation`, `Loader`).

## API

| Method | Endpoint | Xác thực | Kết quả |
| --- | --- | --- | --- |
| POST | `/blogs/ai/chat` | Bearer | Stream SSE (`text/event-stream`) cho `useChat` |
| GET | `/blogs/ai/quota` | Bearer | Lượt còn lại trong ngày |

### `POST /blogs/ai/chat`

```json
{
  "messages": [
    { "id": "msg-1", "role": "user", "parts": [{ "type": "text", "text": "Viết lại đoạn này cho mượt hơn" }] }
  ],
  "editor": {
    "title": "Phở chay Hà Nội",
    "content": "# Phở chay\n\nNước dùng nấu từ củ cải...",
    "selection": "Nước dùng nấu từ củ cải..."
  },
  "blogId": "b1a2d3e4-0000-4000-8000-000000000001"
}
```

| Field | Ràng buộc |
| --- | --- |
| `messages` | 1–40 UI message của `useChat`, cũ trước. Backend kiểm tra từng tool part theo schema bên dưới |
| `editor.title` | string ≤ 150, được rỗng |
| `editor.content` | Markdown ≤ 50.000 ký tự, **trạng thái editor hiện tại** (kể cả chưa lưu) |
| `editor.selection` | Tuỳ chọn, ≤ 4.000 ký tự: text đang bôi đen. Không có thì bỏ field |
| `blogId` | Tuỳ chọn. Blog đã lưu của chính user; agent dùng công thức đã gắn để không bịa nguyên liệu, khẩu phần. Không phải blog của mình → 404 |

`id`, `trigger`, `messageId` do `DefaultChatTransport` tự gửi được chấp nhận.
Field khác bị 400. Tin nhắn cuối phải là:

- tin nhắn `user` có text, tối đa 4.000 ký tự; hoặc
- tin nhắn `assistant` mà **mọi** tool part đã có output (FE gửi lại sau
  `addToolOutput`, xem bên dưới).

Body JSON tối đa 512 KB. Khi hội thoại dài, cắt bớt **cả tin nhắn** cũ nhất
(không cắt giữa một tin nhắn) để còn ≤ 40 tin nhắn.

### `GET /blogs/ai/quota`

```json
{
  "messages": { "feature": "BLOG_CHAT", "used": 12, "limit": 100, "resetsAt": "2026-10-23T17:00:00.000Z" },
  "images": { "feature": "BLOG_IMAGE", "used": 1, "limit": 10, "resetsAt": "2026-10-23T17:00:00.000Z" }
}
```

Ngày tính theo giờ Bangkok (reset lúc 00:00 GMT+7). **Mỗi request** tới
`/blogs/ai/chat` trừ 1 lượt `messages`, kể cả request tự gửi lại sau khi
Accept/Reject một editor tool. Một câu hỏi có hai thay đổi được duyệt sẽ tốn
khoảng 3 lượt. Mỗi ảnh tạo hoặc sửa trừ 1 lượt `images`. Lượt bị moderation
chặn hoặc tạo ảnh lỗi được hoàn lại. Gọi lại quota sau mỗi lượt chat để cập nhật
"Còn X lượt hôm nay".

## Tools

### Editor tools (FE thực thi)

Backend chỉ khai báo schema. Khi agent gọi, stream dừng ở chunk
`tool-input-available`. FE hiện đề xuất, người dùng quyết định, rồi FE trả output.

| Tool | Input | FE làm gì khi Accept |
| --- | --- | --- |
| `replaceSelection` | `{ markdown }` | Thay vùng đã chọn **lúc gửi request** bằng `markdown` |
| `replaceText` | `{ find, replace }` | Tìm `find` trong nội dung, phải xuất hiện đúng 1 lần, thay bằng `replace` |
| `insertMarkdown` | `{ markdown, position: "cursor" \| "end" \| "after", after? }` | Chèn tại con trỏ, cuối bài, hoặc ngay sau đoạn `after` (xuất hiện 1 lần) |
| `setTitle` | `{ title }` (≤ 150) | Đổi ô tiêu đề |
| `insertImage` | `{ url, alt, position, after?, replaces? }` | Chèn `![alt](url)` như `insertMarkdown`; có `replaces` thì thay ảnh có đúng URL đó trong bài (tạo lại/sửa ảnh). Ảnh chỉ đi qua tool này, không nằm trong Markdown của tool khác |

Output FE gửi lại, chung cho cả 5 tool:

```ts
type EditorToolOutput = {
  applied: boolean;
  error?: 'NO_SELECTION' | 'NOT_FOUND' | 'AMBIGUOUS' | 'STALE';
  reason?: string; // ≤ 500, lý do người dùng gõ khi Reject (tuỳ chọn)
};
```

- Accept và áp được: `{ applied: true }`.
- Reject: `{ applied: false }`, có thể kèm `reason`. Agent sẽ hỏi lại, không gửi lại cùng thay đổi.
- Không áp được: `{ applied: false, error }`.
  - `NO_SELECTION`: gọi `replaceSelection` nhưng lúc gửi không có vùng chọn.
  - `NOT_FOUND` / `AMBIGUOUS`: `find` hoặc `after` xuất hiện 0 lần hoặc nhiều hơn 1 lần.
  - `STALE`: người dùng đã sửa đúng chỗ đó trong lúc chờ.

  Gặp `NOT_FOUND` hay `AMBIGUOUS`, agent tự thử lại một lần.

Một lượt có thể có nhiều editor tool liên tiếp: mỗi lần FE trả output, turn
được gửi lại và agent có thể gọi tool tiếp theo.

### Server tools (backend chạy, FE chỉ hiển thị)

| Tool | Input | Output |
| --- | --- | --- |
| `searchKnowledge` | `{ query }` | Đoạn tài liệu dinh dưỡng; chỉ cần hiện "Đang tra tài liệu…" |
| `generateImage` | `{ prompt, aspectRatio: "1:1" \| "4:3" \| "3:4" \| "16:9" }` | `{ url }` hoặc `{ error }` |
| `editImage` | `{ imageUrl, instruction }` | `{ url }` hoặc `{ error }` |

Tạo ảnh mất vài giây: hiện skeleton khi part ở `input-available` và preview khi
có `output-available`. Sau khi có `url`, agent tự gọi `insertImage`, nên FE
không cần tự chèn. `error` là `IMAGE_QUOTA_EXCEEDED`, `IMAGE_PROMPT_REFUSED`,
`IMAGE_NOT_OWNED` hoặc `IMAGE_FAILED`, và agent sẽ giải thích trong câu trả lời.

Ảnh lưu ở bucket blog (`.../vedora-blogs/blogs/{userId}/ai/…`), public-read
như ảnh upload qua `POST /blogs/images/uploads`. `editImage` chỉ sửa được ảnh
nằm trong thư mục của chính user; ảnh gốc giữ nguyên, ảnh sửa có URL mới.

## Tích hợp với `useChat`

```tsx
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, lastAssistantMessageIsCompleteWithToolCalls } from 'ai';

const EDITOR_TOOLS = ['replaceSelection', 'replaceText', 'insertMarkdown', 'setTitle', 'insertImage'];

const { messages, sendMessage, addToolOutput, status, error } = useChat({
  transport: new DefaultChatTransport({
    api: `${API_URL}/api/v1/blogs/ai/chat`,
    headers: () => ({ Authorization: `Bearer ${getAccessToken()}` }),
    // gọi lại mỗi request, nên luôn gửi nội dung editor mới nhất
    body: () => ({
      editor: {
        title: editor.getTitle(),
        content: editor.getMarkdown(),
        ...(editor.getSelectedText() ? { selection: editor.getSelectedText() } : {}),
      },
      ...(blogId ? { blogId } : {}),
    }),
  }),
  // trả xong output cho mọi tool của lượt thì tự gửi lại để agent làm tiếp
  sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
});
```

Lúc gửi tin nhắn, lưu lại **range** của vùng chọn (from/to trong editor) để áp
`replaceSelection` đúng chỗ, kể cả khi người dùng đã click sang chỗ khác.

Render tool part. Editor tool đang chờ (`state === 'input-available'`) là nơi
hiện diff kèm Accept/Reject:

```tsx
{message.parts.map((part) => {
  if (part.type === 'text') return <Markdown key={...}>{part.text}</Markdown>;

  if (part.type === 'tool-replaceSelection' && part.state === 'input-available') {
    return (
      <Confirmation
        diff={{ before: pendingSelection.text, after: part.input.markdown }}
        onAccept={() => {
          const ok = editor.replaceRange(pendingSelection.range, part.input.markdown);
          addToolOutput({
            tool: 'replaceSelection',
            toolCallId: part.toolCallId,
            output: ok ? { applied: true } : { applied: false, error: 'STALE' },
          });
        }}
        onReject={(reason) =>
          addToolOutput({
            tool: 'replaceSelection',
            toolCallId: part.toolCallId,
            output: { applied: false, ...(reason ? { reason } : {}) },
          })
        }
      />
    );
  }
  // tương tự cho replaceText / insertMarkdown / setTitle / insertImage,
  // skeleton/preview cho generateImage / editImage
})}
```

Lưu ý:

- **Không** tự trả output trong `onToolCall` cho editor tool: thay đổi chỉ áp khi người dùng bấm Accept.
- Không render text bằng raw HTML. Câu trả lời của agent đã được lọc link, ảnh và HTML, nhưng Markdown trong tool input sẽ vào bài nên phải hiển thị qua renderer có `raw HTML` tắt, giống trang xem blog.
- Khi stream đang chạy (`status === 'streaming' | 'submitted'`), khoá các nút gửi. Nên khoá cả việc sửa đoạn đang chờ duyệt để hạn chế `STALE`.
- Chunk `start` có `messageMetadata.refused === true` khi tin nhắn bị chặn; backend trả một câu cố định và không gọi tool.

## Lỗi

| HTTP | Trường hợp | FE nên |
| --- | --- | --- |
| 400 | Body sai, hoặc `BLOG_AI_INVALID_MESSAGES` (tool part sai schema, tin nhắn cuối rỗng hay quá 4.000 ký tự, tool chưa có output) | Báo lỗi, kiểm tra lại cách build message |
| 401 | Token thiếu, sai hoặc hết hạn | Refresh token rồi gửi lại |
| 404 | `blogId` không phải blog của user | Bỏ `blogId` |
| 429 | `code: "AI_QUOTA_EXCEEDED"`: hết lượt trong ngày (xem `resetsAt` từ `/quota`), hoặc quá 30 request/phút (không có `code`) | Hiện "Hết lượt hôm nay" hoặc "Thử lại sau ít phút" |
| 503 | Model kiểm duyệt lỗi hoặc timeout | Cho phép thử lại |

Lỗi giữa chừng stream đến dưới dạng chunk `error` với `errorText` là
`RATE_LIMITED` (provider quá tải) hoặc `MODEL_ERROR`. `useChat` đưa vào `error`;
hiện nút "Thử lại" (`regenerate()`).

## Ràng buộc nội dung

- Agent trả lời tiếng Việt và viết vào bài theo ngôn ngữ của bản nháp. Tin nhắn chỉ nhận tiếng Việt hoặc tiếng Anh.
- Con số dinh dưỡng thêm vào bài chỉ lấy từ tài liệu Vedora hoặc từ công thức đã gắn; không có dữ liệu thì agent nói là chưa có.
- Không tạo ảnh người thật, nội dung 18+ hay bạo lực. Prompt ảnh cũng qua kiểm duyệt.
- Ảnh do AI tạo mà không chèn vào bài vẫn nằm trong bucket; hiện chưa có job dọn dẹp.

## Migration và kiểm tra

```bash
npm run start:dev    # Mongoose tự tạo collection ai_usage khi khởi động
npm test -- src/posts/ai src/ai-usage
```

Env backend: `BLOG_AI_MODEL` (nên ghim model gọi tool ổn định),
`OPENROUTER_IMAGE_MODEL=qwen/qwen-image-2.1-turbo`, `BLOG_AI_DAILY_MESSAGES=100`,
`BLOG_AI_DAILY_IMAGES=10`.
