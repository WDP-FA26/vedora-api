import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { AppException } from './app-exception.js';
import { ErrorBodyDto } from './error-body.dto.js';
import type { ErrorCode } from './error-code.js';
import { ExternalServiceException } from './external-service.exception.js';

/** Codes for framework errors (Throttler, route 404, body size) that carry no code of their own. */
const FRAMEWORK_CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'FILE_TOO_LARGE',
  415: 'UNSUPPORTED_FILE_TYPE',
  429: 'TOO_MANY_REQUESTS',
  503: 'SERVICE_UNAVAILABLE',
};

function isAppException(value: unknown): value is AppException<ErrorCode> {
  return value instanceof AppException;
}

export function toErrorBody(exception: unknown): ErrorBodyDto {
  if (isAppException(exception)) {
    return {
      statusCode: exception.statusCode,
      code: exception.code,
      message: exception.message,
      details: exception.details,
    };
  }
  if (exception instanceof HttpException) {
    const statusCode = exception.getStatus();
    return {
      statusCode,
      code:
        FRAMEWORK_CODE_BY_STATUS[statusCode] ??
        (statusCode >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST'),
      message: exception.message,
    };
  }
  // Unknown failures never leak their message to clients.
  return {
    statusCode: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
  };
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const body = toErrorBody(exception);
    if (body.statusCode >= 500) this.logServerError(exception);
    if (response.headersSent) {
      // An SSE stream that already started cannot receive a JSON error body.
      this.logger.warn(`Error after headers were sent: ${body.code}`);
      return;
    }
    response.status(body.statusCode).json(body);
  }

  private logServerError(exception: unknown): void {
    if (exception instanceof ExternalServiceException) {
      this.logger.error(
        `${exception.message}: ${exception.reason}`,
        exception.stack,
      );
      return;
    }
    if (exception instanceof Error) {
      this.logger.error(exception.message, exception.stack);
      return;
    }
    this.logger.error(String(exception));
  }
}
