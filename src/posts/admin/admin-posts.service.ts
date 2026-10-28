import { Injectable, NotFoundException } from '@nestjs/common';
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
import { AdminPostDto, AdminPostsQueryDto } from '../dto/admin-post.dto.js';
import { PostRelationsService } from '../post-relations.service.js';

/** Every post whatever its status, for the admin content page. */
@Injectable()
export class AdminPostsService {
  constructor(
    private readonly mediaService: MediaService,
    private readonly relations: PostRelationsService,
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
    if (!row) throw new NotFoundException('Post not found');
    const [dto] = await this.toDtos([row]);
    return dto;
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
