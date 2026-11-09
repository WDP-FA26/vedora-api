import type {
  CursorPaginatedResponseDto,
  PaginatedResponseDto,
} from './paginated-response.dto.js';
import type { PaginationQueryDto } from './pagination-query.dto.js';

export function getPaginationArgs(
  query: Pick<PaginationQueryDto, 'page' | 'limit'>,
): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.limit, take: query.limit };
}

export function createPaginatedResponse<T>(
  items: T[],
  totalItems: number,
  query: Pick<PaginationQueryDto, 'page' | 'limit'>,
): PaginatedResponseDto<T> {
  const { page, limit } = query;
  const totalPages = Math.ceil(totalItems / limit);
  return {
    items,
    meta: {
      page,
      limit,
      totalItems,
      totalPages,
      hasNextPage: page < totalPages,
      hasPreviousPage: page > 1,
    },
  };
}

export function createCursorPaginatedResponse<T extends { id: string }>(
  rows: T[],
  limit: number,
): CursorPaginatedResponseDto<T> {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1].id : null,
  };
}
