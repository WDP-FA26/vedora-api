import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { SupportSyncService } from '../../support/support-sync.service.js';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../../common/pagination/index.js';
import { CaptionService } from '../../media/captions/caption.service.js';
import { AdminMediaDto } from '../../media/dto/media-response.dto.js';
import { MediaService } from '../../media/media.service.js';
import { lockDocument } from '../../mongo/document-lock.js';
import {
  AppealOutcome,
  type MediaAsset,
  NotificationType,
  Post,
  type PostModeration,
  type PostRemoval,
  PostRemovalActor,
  PostStatus,
  type SupportTicket,
} from '../../mongo/models.js';
import { MongoService } from '../../mongo/mongo.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import {
  type AdminModerationDto,
  AdminPostDto,
  type AdminPostRemovalDto,
  AdminPostsQueryDto,
  type ModerationDecision,
} from '../dto/admin-post.dto.js';
import { PostModerationService } from '../../media/post-moderation.service.js';
import { StateConflictException } from '../../common/exceptions/state-conflict.exception.js';
import { PostRelationsService } from '../post-relations.service.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import { PostReportsService } from '../interactions/post-reports.service.js';
import { PostSearchIndexService } from '../search/post-search-index.service.js';

function toModerationDto(
  moderation: PostModeration | null,
): AdminModerationDto | null {
  if (!moderation) return null;
  return {
    verdict: moderation.verdict,
    riskLevel: moderation.riskLevel ?? null,
    checkedAt: moderation.checkedAt,
    reviewedById: moderation.reviewedById,
    reviewedAt: moderation.reviewedAt,
    reviewNote: moderation.reviewNote,
    evidence: moderation.evidence ?? null,
  };
}

function toRemovalDto(
  removal: PostRemoval | null | undefined,
): AdminPostRemovalDto | null {
  if (!removal) return null;
  return {
    removedById: removal.removedById,
    removedByRole: removal.removedByRole,
    removedAt: removal.removedAt,
    previousStatus: removal.previousStatus,
    reason: removal.reason,
    restoredById: removal.restoredById,
    restoredAt: removal.restoredAt,
  };
}

@Injectable()
export class AdminPostsService {
  constructor(
    private readonly mongo: MongoService,
    private readonly mediaService: MediaService,
    private readonly relations: PostRelationsService,
    private readonly postModeration: PostModerationService,
    private readonly reports: PostReportsService,
    private readonly searchIndex: PostSearchIndexService,
    private readonly captions: CaptionService,
    private readonly notifications: NotificationsService,
    private readonly supportSync: SupportSyncService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
  ) {}

  async remove(id: string, adminId: string, reason?: string): Promise<void> {
    const notifications = await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'post', id);
      const post = await this.posts
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!post) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
      }
      if (post.status === PostStatus.REMOVED) {
        throw new StateConflictException(
          'POST_ALREADY_REMOVED',
          'Post is already removed',
        );
      }
      const notice = await this.reports.removalNotice(id, session);
      if (!notice)
        throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
      const trimmedReason = reason?.trim() || notice.reason || null;
      const now = new Date();
      await this.posts
        .updateOne(
          { _id: id },
          {
            $set: {
              status: PostStatus.REMOVED,
              removal: {
                removedById: adminId,
                removedByRole: PostRemovalActor.ADMIN,
                removedAt: now,
                previousStatus: post.status,
                reason: trimmedReason,
                restoredById: null,
                restoredAt: null,
              },
              searchIndexedAt: null,
            },
          },
          { session },
        )
        .exec();
      await this.reports.resolvePendingForPost(session, id, adminId, now);
      const closedAppeal =
        await this.supportSync.closeActiveAppealOnAdminAction(session, {
          postId: id,
          adminId,
          outcome: AppealOutcome.REJECTED,
          note: trimmedReason,
          now,
        });
      const stored = await this.reports.storeRemovalNotifications(
        notice,
        session,
        trimmedReason,
      );
      if (closedAppeal) {
        stored.push(
          ...(await this.notifications.storeSystemNotifications(
            [
              {
                recipientId: closedAppeal.authorId,
                type: NotificationType.SUPPORT_TICKET_RESOLVED,
                postId: id,
                ticketId: closedAppeal.id,
                reason: 'APPEAL_REJECTED',
                note: trimmedReason ?? undefined,
              },
            ],
            session,
          )),
        );
      }
      return stored;
    });
    await this.notifications.publishStored(notifications);
    await this.searchIndex.remove(id);
  }

  async restore(
    id: string,
    adminId: string,
    note?: string,
  ): Promise<AdminPostDto> {
    const trimmedNote = note?.trim() || null;
    let targetStatus: PostStatus = PostStatus.PUBLISHED;
    let authorId = '';
    let removedByRole: PostRemovalActor | null = null;
    let closedAppeal: SupportTicket | null = null;

    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'post', id);
      const post = await this.posts
        .findOne({ _id: id })
        .session(session)
        .exec();
      if (!post) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
      }
      if (post.status !== PostStatus.REMOVED) {
        throw new StateConflictException(
          'POST_NOT_REMOVED',
          'Only a removed post can be restored',
        );
      }
      const previous = post.removal?.previousStatus;
      targetStatus =
        previous && previous !== PostStatus.REMOVED
          ? previous
          : PostStatus.PUBLISHED;
      authorId = post.authorId;
      removedByRole = post.removal?.removedByRole ?? null;
      const now = new Date();
      await this.posts
        .updateOne(
          { _id: id },
          {
            $set: {
              status: targetStatus,
              publishedAt:
                targetStatus === PostStatus.PUBLISHED
                  ? (post.publishedAt ?? now)
                  : post.publishedAt,
              'removal.restoredById': adminId,
              'removal.restoredAt': now,
              searchIndexedAt: null,
            },
          },
          { session },
        )
        .exec();
      closedAppeal = await this.supportSync.closeActiveAppealOnAdminAction(
        session,
        {
          postId: id,
          adminId,
          outcome: AppealOutcome.APPROVED,
          note: trimmedNote,
          now,
        },
      );
    });

    if (targetStatus === PostStatus.PUBLISHED) {
      this.searchIndex.schedule();
      this.captions.schedule();
    }
    if (closedAppeal !== null) {
      const closed: SupportTicket = closedAppeal;
      await this.notifications.notify({
        recipientId: closed.authorId,
        type: NotificationType.SUPPORT_TICKET_RESOLVED,
        postId: id,
        ticketId: closed.id,
        reason: 'APPEAL_APPROVED',
        note: trimmedNote ?? undefined,
      });
    } else if (
      authorId &&
      authorId !== adminId &&
      removedByRole === PostRemovalActor.ADMIN
    ) {
      await this.notifications.notify({
        recipientId: authorId,
        type: NotificationType.POST_RESTORED,
        postId: id,
        note: trimmedNote ?? undefined,
      });
    }

    return this.findOne(id);
  }

  async findAll(
    query: AdminPostsQueryDto,
  ): Promise<PaginatedResponseDto<AdminPostDto>> {
    const { skip, take } = getPaginationArgs(query);
    const filter = query.status ? { status: query.status } : {};
    const [rows, totalItems] = await Promise.all([
      this.posts
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(take)
        .exec(),
      this.posts.countDocuments(filter).exec(),
    ]);
    return createPaginatedResponse(await this.toDtos(rows), totalItems, query);
  }

  async findOne(id: string): Promise<AdminPostDto> {
    const row = await this.posts.findOne({ _id: id }).exec();
    if (!row)
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  async moderate(
    id: string,
    adminId: string,
    decision: ModerationDecision,
    note: string | undefined,
  ): Promise<AdminPostDto> {
    const exists = await this.posts.exists({ _id: id });
    if (!exists)
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    const applied = await this.postModeration.decide(
      id,
      adminId,
      decision,
      note ?? null,
    );
    if (!applied) {
      throw new StateConflictException(
        'POST_NOT_REVIEWABLE',
        'Only a post waiting for review, a rejected one, or (to reject it) one the reviewer model published can be moderated',
      );
    }
    return this.findOne(id);
  }

  private async toDtos(rows: Post[]): Promise<AdminPostDto[]> {
    const relations = await this.relations.hydrate(rows);
    return rows.flatMap((row) => {
      const related = relations.get(row.id);
      if (!related) return [];
      return [
        {
          id: row.id,
          type: row.type,
          status: row.status,
          body: row.body,
          blog: related.blog,
          publishedAt: row.publishedAt,
          createdAt: row.createdAt,
          author: related.author,
          media: related.media.map((media) => this.toMediaDto(media)),
          commentCount: related.commentCount,
          likeCount: related.likeCount,
          repostCount: related.repostCount,
          viewCount: row.viewCount,
          moderation: toModerationDto(row.moderation),
          removal: toRemovalDto(row.removal),
        },
      ];
    });
  }

  private toMediaDto(media: MediaAsset): AdminMediaDto {
    return {
      ...this.mediaService.toResponse(media),
      captionStatus: media.captionStatus,
      captionLanguage: media.captionLanguage,
    };
  }
}
