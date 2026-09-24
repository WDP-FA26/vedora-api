import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

/** The unparsed request body; needs `rawBody: true` in `NestFactory.create`. */
export const RawBody = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Buffer | undefined =>
    context.switchToHttp().getRequest<RawBodyRequest<Request>>().rawBody,
);
