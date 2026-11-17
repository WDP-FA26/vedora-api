import { Injectable } from '@nestjs/common';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MediaService } from '../media/media.service.js';
import { MediaAsset, Post, PostStatus, PostType } from '../mongo/models.js';
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
   * Edits the text of a short post. Changed text is moderated again like a
   * new post: the post is PROCESSING until the verdict, so a rejected or held
   * post can be fixed and resubmitted. Videos cannot be swapped.
   */
  async update(
    id: string,
    authorId: string,
    dto: UpdatePostDto,
  ): Promise<PostResponseDto> {
    const body = dto.body || null;
    let changed = false;
    await this.mongo.withTransaction(async (session) => {
      await lockDocument(this.mongo, session, 'post', id);
      const current = await this.posts
        .findOne({ _id: id, type: PostType.POST })
        .session(session)
        .exec();
      if (!current) {
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
          'This post is still being processed and cannot be edited yet',
        );
      }
      if (body === current.body) return;
      if (!body) {
        const videos = await this.media
          .countDocuments({ postId: id, discardedAt: null })
          .session(session)
          .exec();
        if (videos === 0) {
          throw new InvalidInputException(
            'EMPTY_POST',
            'A post needs text or a video',
          );
        }
      }
      changed = true;
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
    return this.postsQuery.load(id, authorId);
  }

  async remove(id: string, authorId: string): Promise<void> {
    const post = await this.posts
      .findOne({ _id: id })
      .select('authorId')
      .exec();
    if (!post) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    }
    if (post.authorId !== authorId) {
      throw new AccessDeniedException(
        'FORBIDDEN',
        'Only the author can delete this post',
      );
    }
    await this.destroy(id);
  }

  async removeAsAdmin(id: string): Promise<void> {
    const post = await this.posts.findOne({ _id: id }).select('_id').exec();
    if (!post) {
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    }
    await this.destroy(id);
  }

  private async destroy(id: string): Promise<void> {
    const media = await this.media.find({ postId: id }).select('_id').exec();
    await this.mongo.withTransaction((session) =>
      this.posts.deleteOne({ _id: id }, { session }).exec(),
    );
    await this.searchIndex.remove(id);
    await this.mediaService.discard({
      _id: { $in: media.map((item) => item.id) },
    });
  }
}
