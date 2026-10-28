import { AppException } from './app-exception.js';

export const EXTERNAL_SERVICES = [
  'openrouter',
  'qdrant',
  'cloudinary',
] as const;
export type ExternalService = (typeof EXTERNAL_SERVICES)[number];

/**
 * A third-party dependency failed. The public message stays generic; `reason`
 * (vendor status, vendor message) is only logged. 502.
 */
export class ExternalServiceException extends AppException<'EXTERNAL_SERVICE_FAILED'> {
  readonly statusCode = 502;

  constructor(
    readonly service: ExternalService,
    readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(
      'EXTERNAL_SERVICE_FAILED',
      `${service} request failed`,
      { service },
      options,
    );
  }
}
