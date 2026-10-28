import {
  createCursorPaginatedResponse,
  createPaginatedResponse,
} from './pagination.js';

describe('Page pagination responses', () => {
  it('describes a first page with remaining results', () => {
    const items = [{ name: 'First' }];
    expect(createPaginatedResponse(items, 23, { page: 1, limit: 10 })).toEqual({
      items,
      meta: {
        page: 1,
        limit: 10,
        totalItems: 23,
        totalPages: 3,
        hasNextPage: true,
        hasPreviousPage: false,
      },
    });
  });

  it('marks the last partial page as having no next page', () => {
    const result = createPaginatedResponse(['Last'], 21, {
      page: 3,
      limit: 10,
    });
    expect(result.meta).toMatchObject({
      totalPages: 3,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  it('does not create another page for an exact multiple of the limit', () => {
    expect(
      createPaginatedResponse([], 20, { page: 2, limit: 10 }).meta,
    ).toMatchObject({
      totalPages: 2,
      hasNextPage: false,
    });
  });

  it('reports zero pages for an empty collection', () => {
    expect(createPaginatedResponse([], 0, { page: 1, limit: 20 })).toEqual({
      items: [],
      meta: {
        page: 1,
        limit: 20,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
        hasPreviousPage: false,
      },
    });
  });

  it('preserves an out-of-range page instead of silently returning another page', () => {
    expect(
      createPaginatedResponse([], 3, { page: 5, limit: 20 }),
    ).toMatchObject({
      items: [],
      meta: {
        page: 5,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: true,
      },
    });
  });
});

describe('Cursor pagination responses', () => {
  it('uses the last returned ID as cursor and excludes the lookahead row', () => {
    const rows = [{ id: 'first' }, { id: 'second' }, { id: 'lookahead' }];
    expect(createCursorPaginatedResponse(rows, 2)).toEqual({
      items: [rows[0], rows[1]],
      nextCursor: 'second',
    });
    expect(rows).toHaveLength(3);
  });

  it('reports no next cursor when exactly one page remains', () => {
    const rows = [{ id: 'first' }, { id: 'last' }];
    expect(createCursorPaginatedResponse(rows, 2)).toEqual({
      items: rows,
      nextCursor: null,
    });
  });

  it('reports no next cursor for a partial page', () => {
    expect(createCursorPaginatedResponse([{ id: 'last' }], 20)).toEqual({
      items: [{ id: 'last' }],
      nextCursor: null,
    });
  });

  it('returns an empty page without accessing a missing last item', () => {
    expect(createCursorPaginatedResponse([], 20)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
