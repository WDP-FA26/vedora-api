import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../../common/pagination/index.js';
import { AdminMediaDto } from '../../media/dto/media-response.dto.js';
import { MediaService } from '../../media/media.service.js';
import { type MediaAsset, Post } from '../../mongo/models.js';
import {
  AdminPostDto,
  AdminPostsQueryDto,
  type ModerationDecision,
} from '../dto/admin-post.dto.js';
import { PostModerationService } from '../../media/post-moderation.service.js';
import { StateConflictException } from '../../common/exceptions/state-conflict.exception.js';
import { PostRelationsService } from '../post-relations.service.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';

@Injectable()
export class AdminPostsService {
  constructor(
    private readonly mediaService: MediaService,
    private readonly relations: PostRelationsService,
    private readonly postModeration: PostModerationService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
  ) {}

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
        'Only a post waiting for review or a rejected one can be moderated',
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
          moderation: row.moderation,
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
