/** Extra, code-specific fields returned under `details` in the error body. */
export type ErrorDetails = Record<string, unknown>;

/**
 * Base class for every exception the API reports to clients. Subclasses fix
 * the HTTP status of their family; the throw site supplies the business code
 * and the message. The global filter returns `statusCode`, `code`, `message`
 * and `details` as the response body, so services never mention HTTP.
 */
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
