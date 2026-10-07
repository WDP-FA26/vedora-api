import {
  BadRequestException,
  ConflictException,
  HttpStatus,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Prisma codes: unique violation, foreign key violation, record not found. */
type PrismaErrorCode = 'P2002' | 'P2003' | 'P2025';

export function isPrismaError(error: unknown, code: PrismaErrorCode): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === code
  );
}

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
