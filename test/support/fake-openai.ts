import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { z } from 'zod';

const bodySchema = z.object({
  model: z.string(),
  stream: z.boolean().optional(),
  text: z.unknown().optional(),
  questions: z
    .array(
      z.object({
        name: z.string(),
        choices: z.array(z.object({ value: z.string() })),
      }),
    )
    .optional(),
  input: z.unknown().optional(),
});

/** Local protocol fixture only. It refuses any credential other than the explicit fake key. */
export function fakeOpenAI(port: number, host = '127.0.0.1') {
  const requests: {
    path: string;
    model: string;
    stream: boolean;
    input: unknown;
  }[] = [];
  let refuse = false;
  const replyText = 'Tofu and mushrooms make a vegetarian soup.';
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url === '/turnstile' && request.method === 'POST') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"success":true}');
      return;
    }
    if (request.headers.authorization !== 'Bearer fixture-openai-only') {
      response.writeHead(401).end();
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.from(chunk as Uint8Array));
      const body = bodySchema.parse(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      const path = request.url ?? '';
      requests.push({
        path,
        model: body.model,
        stream: body.stream === true,
        input: body.input,
      });
      if (path === '/v1/decisions') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            id: 'dec_fixture',
            model: body.model,
            usage: { input_tokens: 10, output_tokens: 2 },
            answers: (body.questions ?? []).map(({ name, choices }) => {
              if (refuse) return { name, type: 'refusal' };
              const choice = choices.some(({ value }) => value === 'allow')
                ? 'allow'
                : choices[0].value;
              return {
                name,
                type: 'choice',
                choice,
                probabilities: choices.map(({ value }) => ({
                  value,
                  probability: value === choice ? 1 : 0,
                })),
              };
            }),
          }),
        );
        return;
      }
      if (path === '/v1/responses') {
        const text = body.text
          ? JSON.stringify({
              title: 'Fixture tofu soup',
              pages: ['Fixture PDF page'],
            })
          : replyText;
        const result = {
          id: 'resp_fixture',
          object: 'response',
          model: body.model,
          created_at: 1795000000,
          status: 'completed',
          output: [
            {
              type: 'message',
              id: 'msg_fixture',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          ],
          usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
        };
        if (!body.stream) {
          response
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify(result));
          return;
        }
        const events = [
          {
            type: 'response.created',
            response: { ...result, output: [], status: 'in_progress' },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: {
              type: 'message',
              id: 'msg_fixture',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          },
          {
            type: 'response.output_text.delta',
            output_index: 0,
            item_id: 'msg_fixture',
            content_index: 0,
            delta: text,
          },
          {
            type: 'response.output_text.done',
            item_id: 'msg_fixture',
            output_index: 0,
            content_index: 0,
            text,
          },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: result.output[0],
          },
          { type: 'response.completed', response: result },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const event of events)
          response.write(`data: ${JSON.stringify(event)}\n\n`);
        response.end();
        return;
      }
      response.writeHead(404).end();
    } catch {
      response.writeHead(400).end();
    }
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  return {
    requests,
    replyText,
    refuse(value: boolean) {
      refuse = value;
    },
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
