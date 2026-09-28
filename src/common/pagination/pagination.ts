import type {
  CursorPaginatedResponseDto,
  PaginatedResponseDto,
} from './paginated-response.dto';
import type { PaginationQueryDto } from './pagination-query.dto';

/** Only derive database offsets from a validated page/limit query. */
export function getPaginationArgs(
  query: Pick<PaginationQueryDto, 'page' | 'limit'>,
): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.limit, take: query.limit };
}

/** The query has already been validated and the items already sliced by the DB. */
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

/** Fetch limit + 1 rows with a stable order; the extra row is only a lookahead. */
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
