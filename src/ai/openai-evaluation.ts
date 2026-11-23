import { APICallError, type Experimental_EvaluationModel } from 'ai';
import { z } from 'zod';

type Evaluation = Exclude<Experimental_EvaluationModel, string>;
type State = Parameters<Evaluation['doEvaluate']>[0]['state'];
const resultSchema = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  usage: z
    .object({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
  answers: z.array(
    z.discriminatedUnion('type', [
      z.object({
        type: z.literal('choice'),
        name: z.string(),
        choice: z.string(),
        probabilities: z.array(
          z.object({
            value: z.string(),
            probability: z.number().min(0).max(1),
          }),
        ),
      }),
      z.object({
        type: z.literal('refusal'),
        name: z.string().nullable().optional(),
      }),
    ]),
  ),
});
const text = (value: unknown) =>
  typeof value === 'string' ? value : JSON.stringify(value);
function inputParts(state: State) {
  const parts: readonly unknown[] = Array.isArray(state) ? state : [state];
  return parts.map((part) => {
    if (
      part &&
      typeof part === 'object' &&
      !Array.isArray(part) &&
      (part as Record<string, unknown>).type === 'image_url'
    ) {
      const image = (part as Record<string, unknown>).image_url;
      const url =
        image && typeof image === 'object' && !Array.isArray(image)
          ? (image as Record<string, unknown>).url
          : undefined;
      if (
        typeof url !== 'string' ||
        !/^data:image\/[a-z0-9.+-]+;base64,/i.test(url)
      )
        throw new Error('Evaluation requires inline image data');
      return { type: 'input_image', image_url: url };
    }
    return { type: 'input_text', text: text(part) };
  });
}

/** Native Decisions preserves provider probabilities; it does not ask a chat model to invent confidence scores. */
export function openaiEvaluation({
  apiKey,
  modelId,
  baseURL,
  fetch: customFetch = fetch,
}: {
  apiKey: string;
  modelId: string;
  baseURL: string;
  fetch?: typeof fetch;
}): Evaluation {
  return {
    specificationVersion: 'v4',
    provider: 'openai.decisions',
    modelId,
    supportedQuestionTypes: ['choice'],
    async doEvaluate({ state, questions, abortSignal }) {
      const body = {
        model: modelId,
        input: [{ role: 'user', content: inputParts(state) }],
        questions: Object.entries(questions).map(([name, question]) => {
          if (question.type !== 'choice')
            throw new Error('Only choice policies are used by Vedora');
          return {
            type: 'choice',
            name,
            instructions: text(question.instructions),
            choices: Object.entries(question.criteria).map(
              ([value, description]) => ({
                value,
                ...(description === null
                  ? {}
                  : { description: text(description) }),
              }),
            ),
          };
        }),
      };
      const url = `${baseURL.replace(/\/$/, '')}/decisions`;
      const response = await customFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: abortSignal,
      });
      if (!response.ok)
        throw new APICallError({
          message: `OpenAI Decisions answered ${response.status}`,
          url,
          requestBodyValues: { model: modelId },
          statusCode: response.status,
          isRetryable: response.status === 429 || response.status >= 500,
        });
      const parsed = resultSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('Invalid OpenAI Decisions response');
      const result = parsed.data;
      const answers: Awaited<ReturnType<Evaluation['doEvaluate']>>['answers'] =
        {};
      for (const answer of result.answers) {
        if (answer.type === 'refusal')
          throw new APICallError({
            message: 'OpenAI refused this evaluation',
            url,
            requestBodyValues: { model: modelId },
            statusCode: 400,
            responseBody: '{"error":{"code":"prohibited_content"}}',
            isRetryable: false,
          });
        const question = questions[answer.name];
        if (!question || question.type !== 'choice' || answers[answer.name])
          throw new Error('Unexpected or duplicated decision answer');
        const keys = Object.keys(question.criteria);
        const values = answer.probabilities.map((part) => part.value);
        const total = answer.probabilities.reduce(
          (sum, part) => sum + part.probability,
          0,
        );
        if (
          !keys.includes(answer.choice) ||
          values.length !== keys.length ||
          new Set(values).size !== keys.length ||
          values.some((key) => !keys.includes(key)) ||
          Math.abs(total - 1) > 0.0001
        )
          throw new Error('Incomplete decision probability distribution');
        answers[answer.name] = {
          type: 'choice',
          choice: answer.choice,
          probabilities: Object.fromEntries(
            answer.probabilities.map(({ value, probability }) => [
              value,
              probability / total,
            ]),
          ),
        };
      }
      if (Object.keys(answers).length !== Object.keys(questions).length)
        throw new Error('Missing decision answers');
      return {
        answers,
        warnings: [],
        usage: {
          inputTokens: result.usage?.input_tokens,
          outputTokens: result.usage?.output_tokens,
        },
        response: { id: result.id, modelId: result.model, body: result },
      };
    },
  };
}
