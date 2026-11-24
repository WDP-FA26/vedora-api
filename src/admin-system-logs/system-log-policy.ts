import { isUUID } from 'class-validator';
import type { SystemLogResource } from '../mongo/models.js';

const RESOURCES: Record<string, [SystemLogResource, string]> = {
  users: ['USER', 'tài khoản'],
  'admin/posts': ['POST', 'bài viết'],
  'admin/reports': ['POST_REPORT', 'báo cáo bài viết'],
  'admin/comment-reports': ['COMMENT_REPORT', 'báo cáo bình luận'],
  'admin/recipes': ['RECIPE', 'công thức'],
  'admin/ingredients': ['INGREDIENT', 'nguyên liệu'],
  'admin/ingredient-groups': ['INGREDIENT_GROUP', 'nhóm nguyên liệu'],
  'admin/incompatibility-rules': ['INCOMPATIBILITY_RULE', 'quy tắc kết hợp'],
  'knowledge/documents': ['KNOWLEDGE', 'tài liệu kiến thức'],
  'admin/moderation/settings': ['MODERATION_SETTINGS', 'chính sách kiểm duyệt'],
  'admin/support/tickets': ['SUPPORT_TICKET', 'hồ sơ hỗ trợ'],
  verification: ['VERIFICATION', 'xác minh chuyên gia'],
  'admin/workspaces': ['WORKSPACE', 'trang nhà hàng'],
  'admin/payments': ['PAYMENT', 'thanh toán'],
  'admin/ai-costs': ['AI_COST', 'chi phí AI'],
};

export function systemLogScope(
  controller: string,
  handler: string,
  method: string,
  adminRequired: boolean,
) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return null;
  const sharedUser =
    controller === 'users' && ['PATCH', 'DELETE'].includes(method);
  const sharedComment =
    controller === 'posts/:postId' &&
    handler === 'comments/:commentId' &&
    method === 'DELETE';
  if (
    !adminRequired &&
    !controller.startsWith('admin/') &&
    !sharedUser &&
    !sharedComment
  )
    return null;
  const [resourceType, subject] = sharedComment
    ? (['COMMENT', 'bình luận'] as const)
    : (RESOURCES[controller] ?? ['OTHER', 'quản trị']);
  const tail = handler.split('/').at(-1);
  const verb =
    tail === 'review'
      ? 'Xử lý'
      : tail === 'moderation'
        ? 'Kiểm duyệt'
        : tail === 'restore'
          ? 'Khôi phục'
          : tail === 'test'
            ? 'Kiểm tra'
            : tail === 'claim'
              ? 'Nhận xử lý'
              : tail === 'resolve'
                ? 'Giải quyết'
                : tail === 'close'
                  ? 'Đóng'
                  : tail === 'reconcile'
                    ? 'Đối soát'
                    : method === 'DELETE'
                      ? 'Xóa/gỡ'
                      : method === 'POST'
                        ? 'Tạo/thực hiện'
                        : 'Cập nhật';
  const suffix =
    tail === 'role' ? ' quyền' : tail === 'status' ? ' trạng thái' : '';
  const route = ('/' + controller + '/' + handler)
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
  return {
    route,
    resourceType,
    action: method + ' ' + route,
    actionLabel: verb + suffix + ' ' + subject,
  };
}

export function systemLogTarget(
  params: Record<string, unknown>,
  response: unknown,
): string | null {
  const candidates = Object.values(params).filter(
    (value): value is string => typeof value === 'string' && isUUID(value),
  );
  if (candidates.length) return candidates[candidates.length - 1];
  if (
    response &&
    typeof response === 'object' &&
    'id' in response &&
    typeof response.id === 'string' &&
    isUUID(response.id)
  )
    return response.id;
  return null;
}

/** Explicit enum allowlists; free text, credentials, content and payloads never enter the log. */
export function systemLogChanges(body: unknown) {
  const value =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const pick = (key: string, allowed: string[]) =>
    typeof value[key] === 'string' && allowed.includes(value[key])
      ? value[key]
      : null;
  return {
    decision:
      pick('action', [
        'REMOVE',
        'DISMISS',
        'APPROVE',
        'REJECT',
        'RESOLVE',
        'CLOSE',
      ]) ?? pick('decision', ['APPROVE', 'REJECT', 'ACCEPT', 'DISMISS']),
    targetStatus: pick('status', [
      'ACTIVE',
      'SUSPENDED',
      'DELETED',
      'PENDING_EMAIL',
      'PENDING',
      'RESOLVED',
      'DISMISSED',
      'APPROVED',
      'REJECTED',
      'PUBLISHED',
      'REMOVED',
      'CLOSED',
      'OPEN',
      'IN_PROGRESS',
    ]),
    targetRole: pick('role', ['USER', 'ADMIN']),
  };
}
