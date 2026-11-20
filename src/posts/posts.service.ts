import { Injectable, Optional } from '@nestjs/common';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { SupportSyncService } from '../support/support-sync.service.js';
import { MediaService } from '../media/media.service.js';
import {
  MediaAsset,
  Post,
  PostRemovalActor,
  PostStatus,
  PostType,
} from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { PostSearchIndexService } from './search/post-search-index.service.js';
import { CreatePostDto } from './dto/create-post.dto.js';
import { PostResponseDto } from './dto/post-response.dto.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { PostsQueryService } from './posts-query.service.js';
import { UpdatePostDto } from './dto/update-post.dto.js';
import { lockDocument } from '../mongo/document-lock.js';
import { StateConflictException } from '../common/exceptions/state-conflict.exception.js';

const EDITABLE_STATUSES: PostStatus[] = [
  PostStatus.PUBLISHED,
  PostStatus.PENDING_REVIEW,
  PostStatus.REJECTED,
  PostStatus.FAILED,
];

@Injectable()
export class PostsService {
  constructor(
    private readonly postsQuery: PostsQueryService,
    private readonly mongo: MongoService,
    private readonly mediaService: MediaService,
    private readonly searchIndex: PostSearchIndexService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name) private readonly media: Model<MediaAsset>,
    @Optional() private readonly supportSync?: SupportSyncService,
  ) {}

  async create(authorId: string, dto: CreatePostDto): Promise<PostResponseDto> {
    const body = dto.body || null;
    const mediaIds = dto.mediaIds ?? [];
    if (!body && mediaIds.length === 0) {
      throw new InvalidInputException(
        'EMPTY_POST',
        'A post needs text or a video',
      );
    }

    const id = randomUUID();
    await this.mongo.withTransaction(async (session) => {
      await this.posts.create(
        [
          {
            _id: id,
            authorId,
            type: dto.type,
            status: PostStatus.PROCESSING,
            body,
            searchIndexedAt: null,
            viewCount: 0,
            publishedAt: null,
          },
        ],
        { session },
      );
      await this.mediaService.claimForPost(session, authorId, id, mediaIds);
    });
    await this.mediaService.settlePosts([id]);
    this.searchIndex.schedule();

    return this.postsQuery.load(id, authorId);
  }

  /**
   * Edits a short post's text and/or its videos. Changed content is moderated
   * again like a new post: the post is PROCESSING until every new video is
   * ready and the verdict is in, so a rejected, held or failed post can be
   * fixed and resubmitted.
   */
  async update(
    id: string,
    authorId: string,
    dto: UpdatePostDto,
  ): Promise<PostResponseDto> {
    if (dto.body === undefined && dto.mediaIds === undefined) {
      throw new InvalidInputException(
        'BAD_REQUEST',
        'Provide body or mediaIds',
      );
    }
    let changed = false;
    let detachedIds: string[] = [];
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'post', id);
      const current = await this.posts
        .findOne({ _id: id, type: PostType.POST })
        .session(session)
        .exec();
      if (
        !current ||
        (current.status === PostStatus.REMOVED &&
          current.removal?.removedByRole === PostRemovalActor.AUTHOR)
      ) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
      }
      if (current.authorId !== authorId) {
        throw new AccessDeniedException(
          'FORBIDDEN',
          'Only the author can edit this post',
        );
      }
      if (!EDITABLE_STATUSES.includes(current.status)) {
        throw new StateConflictException(
          'POST_NOT_EDITABLE',
          current.status === PostStatus.REMOVED
            ? 'A removed post cannot be edited'
            : 'This post is still being processed and cannot be edited yet',
        );
      }
      if (this.supportSync) {
        await this.supportSync.assertNoActiveAppeal(id, session);
      }

      const body = dto.body === undefined ? current.body : dto.body || null;
      const mediaCount =
        dto.mediaIds === undefined
          ? await this.media
              .countDocuments({ postId: id, discardedAt: null })
              .session(session)
              .exec()
          : dto.mediaIds.length;
      if (!body && mediaCount === 0) {
        throw new InvalidInputException(
          'EMPTY_POST',
          'A post needs text or a video',
        );
      }

      const bodyChanged = body !== current.body;
      let mediaChanged = false;
      if (dto.mediaIds !== undefined) {
        const replaced = await this.mediaService.replacePostMedia(
          session,
          authorId,
          id,
          dto.mediaIds,
        );
        mediaChanged = replaced.changed;
        detachedIds = replaced.detachedIds;
      }
      changed = bodyChanged || mediaChanged;
      if (!changed) return;

      await this.posts
        .updateOne(
          { _id: id },
          {
            $set: {
              body,
              status: PostStatus.PROCESSING,
              moderation: null,
              searchIndexedAt: null,
              updatedAt: new Date(),
            },
          },
          { session },
        )
        .exec();
    });
    if (changed) {
      await this.mediaService.settlePosts([id]);
      this.searchIndex.schedule();
    }
    if (detachedIds.length > 0) {
      await this.mediaService.discard({ _id: { $in: detachedIds } });
    }
    return this.postsQuery.load(id, authorId);
  }

  async remove(id: string, authorId: string): Promise<void> {
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'post', id);
      const post = await this.posts
        .findOne({ _id: id })
        .select('authorId status removal')
        .session(session)
        .exec();
      if (!post || post.status === PostStatus.REMOVED) {
        throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
      }
      if (post.authorId !== authorId) {
        throw new AccessDeniedException(
          'FORBIDDEN',
          'Only the author can delete this post',
        );
      }
      if (this.supportSync) {
        await this.supportSync.assertNoActiveAppeal(id, session);
      }
      const now = new Date();
      await this.posts
        .updateOne(
          { _id: id },
          {
            $set: {
              status: PostStatus.REMOVED,
              removal: {
                removedById: authorId,
                removedByRole: PostRemovalActor.AUTHOR,
                removedAt: now,
                previousStatus: post.status,
                reason: null,
                restoredById: null,
                restoredAt: null,
              },
              searchIndexedAt: null,
            },
          },
          { session },
        )
        .exec();
    });
    await this.searchIndex.remove(id);
  }
}
