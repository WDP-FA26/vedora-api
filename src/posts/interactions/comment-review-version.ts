import { createHash } from 'node:crypto';
import type { PostComment } from '../../mongo/models.js';

/** Reports/replies bump threadRevision without changing the content version. */
export function commentReviewVersion(comment: PostComment): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: comment.id,
        body: comment.body,
        updatedAt: comment.updatedAt?.toISOString() ?? null,
      }),
    )
    .digest('hex');
}
