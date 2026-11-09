import { Injectable } from '@nestjs/common';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MediaService } from '../media/media.service.js';
import { MediaAsset, Post, PostStatus } from '../mongo/models.js';
import { MongoService } from '../mongo/mongo.service.js';
import { PostSearchIndexService } from './search/post-search-index.service.js';
import { CreatePostDto } from './dto/create-post.dto.js';
import { PostResponseDto } from './dto/post-response.dto.js';
import { AccessDeniedException } from '../common/exceptions/access-denied.exception.js';
import { ResourceNotFoundException } from '../common/exceptions/resource-not-found.exception.js';
import { PostsQueryService } from './posts-query.service.js';

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
