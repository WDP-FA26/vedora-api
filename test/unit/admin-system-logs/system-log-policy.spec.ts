import { randomUUID } from 'node:crypto';
import {
  systemLogChanges,
  systemLogScope,
  systemLogTarget,
} from '../../../src/admin-system-logs/system-log-policy.js';

describe('Administrative history scope and privacy', () => {
  it.each([
    ['admin/ingredients', '', 'POST', true],
    ['users', ':id/role', 'PATCH', true],
    ['users', ':id', 'DELETE', false],
    ['verification', ':id/review', 'POST', true],
    ['knowledge/documents', ':id', 'DELETE', true],
    ['posts/:postId', 'comments/:commentId', 'DELETE', false],
  ])(
    'records administrative mutation %s/%s',
    (controller, handler, method, required) => {
      expect(
        systemLogScope(controller, handler, method, required),
      ).not.toBeNull();
    },
  );
  it.each([
    ['admin/system-logs', '', 'GET', true],
    ['admin/posts', ':id', 'GET', true],
    ['auth', 'login', 'POST', false],
    ['messaging', 'messages', 'POST', false],
    ['posts/:postId', 'comments', 'POST', false],
    ['posts/:postId', 'like', 'POST', false],
    ['payments', 'orders', 'POST', false],
  ])(
    'excludes personal/read traffic %s/%s',
    (controller, handler, method, required) => {
      expect(systemLogScope(controller, handler, method, required)).toBeNull();
    },
  );
  it('accepts only fixed enum metadata, even for malformed bodies', () => {
    expect(
      systemLogChanges({
        action: 'REMOVE',
        status: 'SUSPENDED',
        role: 'ADMIN',
        password: 'Secret',
        reason: 'Private',
      }),
    ).toEqual({
      decision: 'REMOVE',
      targetStatus: 'SUSPENDED',
      targetRole: 'ADMIN',
    });
    for (const value of [
      null,
      [],
      'Secret',
      { action: 'Secret', status: { $ne: null }, role: 'Secret' },
    ])
      expect(systemLogChanges(value)).toEqual({
        decision: null,
        targetStatus: null,
        targetRole: null,
      });
  });
  it('prefers the nested target UUID over parent IDs and rejects untrusted target values', () => {
    const parent = randomUUID();
    const child = randomUUID();
    expect(
      systemLogTarget({ postId: parent, commentId: child }, { id: parent }),
    ).toBe(child);
    expect(
      systemLogTarget({ id: 'sensitive-path' }, { id: 'sensitive-response' }),
    ).toBeNull();
    expect(systemLogTarget({}, { id: child, password: 'Secret' })).toBe(child);
  });
});
