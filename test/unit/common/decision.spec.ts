import { FakeModel, providerError } from '@nestjs/ai/testing';
import { NoObjectGeneratedError } from 'ai';
import {
  decide,
  type DecisionPolicy,
} from '../../../src/common/decision/decision.js';

const POLICY: DecisionPolicy<'allow' | 'deny'> = {
  type: 'choice',
  instructions: 'Allow or deny',
  criteria: { allow: 'fine', deny: 'not fine' },
};

describe('decide', () => {
  it('returns the choice the model answers', async () => {
    const model = new FakeModel([{ object: { choice: 'deny' } }]);

    const result = await decide(
      model,
      'text',
      new AbortController().signal,
      POLICY,
    );

    expect(result).toEqual({ choice: 'deny' });
    expect(model.calls).toHaveLength(1);
  });

  it('lists each category with its definition in the system prompt', async () => {
    const model = new FakeModel([{ object: { choice: 'allow' } }]);

    await decide(model, 'text', new AbortController().signal, POLICY);

    const instructions = model.lastCall?.instructions ?? '';
    expect(instructions).toContain(POLICY.instructions);
    expect(instructions).toContain(
      '<categories>\nallow: fine\ndeny: not fine\n</categories>',
    );
  });

  it('wraps a single message in <message>', async () => {
    const model = new FakeModel([{ object: { choice: 'allow' } }]);

    await decide(model, 'Xin chào', new AbortController().signal, POLICY);

    expect(model.lastCall?.lastUserMessage).toBe(
      'Message:\n<message>Xin chào</message>',
    );
  });

  it('wraps chat turns in <conversation>, oldest first', async () => {
    const model = new FakeModel([{ object: { choice: 'allow' } }]);

    await decide(
      model,
      [
        { role: 'user', text: 'Ăn chay lấy đạm từ đâu?' },
        { role: 'assistant', text: 'Từ các loại đậu.' },
        { role: 'user', text: 'Còn gì nữa?' },
      ],
      new AbortController().signal,
      POLICY,
    );

    expect(model.lastCall?.lastUserMessage).toBe(
      [
        'Conversation, oldest turn first:',
        '<conversation>',
        '<turn role="user">Ăn chay lấy đạm từ đâu?</turn>',
        '<turn role="assistant">Từ các loại đậu.</turn>',
        '<turn role="user">Còn gì nữa?</turn>',
        '</conversation>',
      ].join('\n'),
    );
  });

  it('propagates a model error', async () => {
    const error = providerError(400);
    const model = new FakeModel(() => error);

    await expect(
      decide(model, 'text', new AbortController().signal, POLICY),
    ).rejects.toBe(error);
    expect(model.calls).toHaveLength(1);
  });

  it('does not call the model once the request is aborted', async () => {
    const abort = new AbortController();
    abort.abort(new Error('client closed'));
    const model = new FakeModel([{ object: { choice: 'allow' } }]);

    await expect(decide(model, 'text', abort.signal, POLICY)).rejects.toThrow(
      'client closed',
    );
    expect(model.calls).toHaveLength(0);
  });

  it('refuses an answer outside the choices', async () => {
    const model = new FakeModel([{ object: { choice: 'maybe' } }]);

    await expect(
      decide(model, 'text', new AbortController().signal, POLICY),
    ).rejects.toSatisfy((error) => NoObjectGeneratedError.isInstance(error));
  });
});
