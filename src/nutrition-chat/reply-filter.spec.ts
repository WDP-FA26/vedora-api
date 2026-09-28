import {
  convertArrayToReadableStream,
  convertReadableStreamToArray,
} from 'ai/test';
import type { TextStreamPart, ToolSet } from 'ai';
import { replyFilter } from './reply-filter';

async function filter(deltas: string[]): Promise<string> {
  const parts: TextStreamPart<ToolSet>[] = [
    { type: 'text-start', id: 't' },
    ...deltas.map((text): TextStreamPart<ToolSet> => ({
      type: 'text-delta',
      id: 't',
      text,
    })),
    { type: 'text-end', id: 't' },
  ];
  const output = await convertReadableStreamToArray(
    convertArrayToReadableStream(parts).pipeThrough(
      replyFilter<ToolSet>()({ tools: {}, stopStream: () => {} }),
    ),
  );
  return output
    .map((part) => (part.type === 'text-delta' ? part.text : ''))
    .join('');
}

describe('replyFilter', () => {
  it('passes ordinary text through, word by word', async () => {
    expect(
      await filter(['Đậu phụ có ', '350 mg can', 'xi.\n\n- **Đậu**']),
    ).toBe('Đậu phụ có 350 mg canxi.\n\n- **Đậu**');
  });

  it('drops a code block even when split across chunks', async () => {
    expect(
      await filter([
        'Canxi tốt.\n``',
        '`python\ndef sort(a):\n',
        '    return a\n``',
        '`\nHết.',
      ]),
    ).toBe('Canxi tốt.\nHết.');
  });

  it('removes images and keeps only the text of links', async () => {
    expect(
      await filter([
        'Xem ![ok](https://evil.example/log?q=',
        'canxi) và [voucher](https://phish.example/login) nhé!',
      ]),
    ).toBe('Xem  và voucher nhé!');
  });

  it('removes bare URLs and HTML tags but keeps comparisons', async () => {
    expect(
      await filter(['Mở https://evil.example/x ngay <img src=x> nếu p < 0.05']),
    ).toBe('Mở  ngay  nếu p < 0.05');
  });

  it('drops an unterminated code block at the end of the reply', async () => {
    expect(await filter(['Được.\n```js\nalert(1)'])).toBe('Được.\n');
  });
});
