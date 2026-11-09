export type ErrorDetails = Record<string, unknown>;

export abstract class AppException<Code extends string> extends Error {
  abstract readonly statusCode: number;

  constructor(
    readonly code: Code,
    message: string,
    readonly details?: ErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}
