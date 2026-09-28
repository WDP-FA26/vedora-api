import { ApiProperty } from '@nestjs/swagger';

export class PaginationMetaDto {
  @ApiProperty({ minimum: 1, example: 1 })
  page!: number;

  @ApiProperty({ minimum: 1, example: 20 })
  limit!: number;

  @ApiProperty({ minimum: 0, example: 45 })
  totalItems!: number;

  @ApiProperty({ minimum: 0, example: 3 })
  totalPages!: number;

  @ApiProperty({ example: true })
  hasNextPage!: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage!: boolean;
}

export class PaginatedResponseDto<T> {
  @ApiProperty({ type: [Object] })
  items!: T[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

export class CursorPaginatedResponseDto<T> {
  @ApiProperty({ type: [Object] })
  items!: T[];

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'Last returned item ID when another page exists; otherwise null',
  })
  nextCursor!: string | null;
}
