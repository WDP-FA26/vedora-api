import {
  applyDecorators,
  CanActivate,
  Injectable,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import { ResourceNotFoundException } from '../exceptions/resource-not-found.exception.js';

@Injectable()
export class DisabledEndpointGuard implements CanActivate {
  canActivate(): never {
    throw new ResourceNotFoundException(
      'NOT_FOUND',
      'This endpoint is disabled',
    );
  }
}

export function DisabledEndpoint() {
  return applyDecorators(
    ApiExcludeEndpoint(),
    UseGuards(DisabledEndpointGuard),
  );
}
