import { ApiProperty } from '@nestjs/swagger';
import { ERROR_CODES, type ErrorCode } from './error-code.js';

/**
 * The body of every error response. The filter builds it and Swagger documents
 * it, so the two cannot drift apart. Code-specific fields are listed in
 * docs/docs-for-FE/errors.md.
 */
export class ErrorBodyDto {
  @ApiProperty({ example: 409, description: 'Same as the HTTP status.' })
  statusCode!: number;

  @ApiProperty({
    enum: [...ERROR_CODES],
    description: 'Machine-readable reason. Branch on this, not on message.',
  })
  code!: ErrorCode;

  @ApiProperty({
    description:
      'Text for debugging, not for end users. Validation errors join their messages with "; ".',
  })
  message!: string;

  @ApiProperty({
    type: Object,
    required: false,
    description: 'Code-specific fields, such as email or problems.',
  })
  details?: Record<string, unknown>;
}
