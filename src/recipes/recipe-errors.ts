import {
  BadRequestException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
/** A 409 the admin UI tells apart by `code`. */
export function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: HttpStatus.CONFLICT,
    error: 'Conflict',
    code,
    message,
  });
}

export function badRequest(code: string, message: string): BadRequestException {
  return new BadRequestException({
    statusCode: HttpStatus.BAD_REQUEST,
    error: 'Bad Request',
    code,
    message,
  });
}
