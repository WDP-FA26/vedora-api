import { runtimeConfig } from '../../config/runtime-config.js';
import {
  NotificationType,
  type CommentReport,
  type PostComment,
} from '../../mongo/models.js';
import type { SystemNotifyInput } from '../../notifications/notifications.service.js';
import { isSystemAccount } from '../../users/system-account.js';

function excerpt(body: string) {
  const text = body.replace(/\s+/g, ' ').trim();
  const max = runtimeConfig.NOTIFICATION_EXCERPT_MAX_LENGTH;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function commentRemovalNotifications(
  comments: PostComment[],
  targetId: string,
  actorId: string,
  source: 'ADMIN' | 'POST_OWNER',
  postId?: string,
  reason?: string,
): SystemNotifyInput[] {
  const notices = new Map<string, SystemNotifyInput>();
  const ordered = [...comments].sort(
    (a, b) => Number(b.id === targetId) - Number(a.id === targetId),
  );
  for (const comment of ordered) {
    if (
      comment.authorId === actorId ||
      isSystemAccount(comment.authorId) ||
      notices.has(comment.authorId)
    )
      continue;
    const direct = comment.id === targetId;
    notices.set(comment.authorId, {
      recipientId: comment.authorId,
      type: direct
        ? source === 'ADMIN'
          ? NotificationType.COMMENT_REMOVED
          : NotificationType.COMMENT_REMOVED_BY_POST_OWNER
        : NotificationType.COMMENT_THREAD_REMOVED,
      postId,
      note: excerpt(comment.body),
      reason: direct ? reason : undefined,
    });
  }
  return [...notices.values()];
}

export function commentReportNotifications(
  reports: CommentReport[],
  actorId: string,
  type:
    | NotificationType.COMMENT_REPORT_RESOLVED
    | NotificationType.COMMENT_REPORT_DISMISSED,
  postId?: string,
): SystemNotifyInput[] {
  const notices = new Map<string, SystemNotifyInput>();
  for (const report of reports) {
    if (
      report.reporterId === actorId ||
      isSystemAccount(report.reporterId) ||
      notices.has(report.reporterId)
    )
      continue;
    notices.set(report.reporterId, {
      recipientId: report.reporterId,
      type,
      postId,
      reason: report.reason,
      note: excerpt(report.bodySnapshot),
    });
  }
  return [...notices.values()];
}
