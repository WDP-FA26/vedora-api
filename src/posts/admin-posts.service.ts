import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  createPaginatedResponse,
  getPaginationArgs,
  PaginatedResponseDto,
} from '../common/pagination';
import { AdminMediaDto } from '../media/dto/media-response.dto';
import { MediaService } from '../media/media.service';
import {
  Blog,
  BlogRecipe,
  MediaAsset,
  Post,
  PostBookmark,
  PostComment,
  PostLike,
  PostRepost,
  Recipe,
  User,
} from '../mongo/models';
import { AdminPostDto, AdminPostsQueryDto } from './dto/admin-post.dto';
import { loadPostRelations, type PostRelationModels } from './post-relations';

/** Every post whatever its status, for the admin content page. */
@Injectable()
export class AdminPostsService {
  constructor(
    private readonly mediaService: MediaService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
    @InjectModel(MediaAsset.name) private readonly media: Model<MediaAsset>,
    @InjectModel(PostComment.name)
    private readonly comments: Model<PostComment>,
    @InjectModel(PostLike.name) private readonly likes: Model<PostLike>,
    @InjectModel(PostRepost.name)
    private readonly reposts: Model<PostRepost>,
    @InjectModel(PostBookmark.name)
    private readonly bookmarks: Model<PostBookmark>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Blog.name) private readonly blogs: Model<Blog>,
    @InjectModel(BlogRecipe.name)
    private readonly blogRecipes: Model<BlogRecipe>,
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
  ) {}

  private get relationModels(): PostRelationModels {
    return {
      users: this.users,
      media: this.media,
      comments: this.comments,
      likes: this.likes,
      reposts: this.reposts,
      bookmarks: this.bookmarks,
      blogs: this.blogs,
      blogRecipes: this.blogRecipes,
      recipes: this.recipes,
    };
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
    if (!row) throw new NotFoundException('Post not found');
    const [dto] = await this.toDtos([row]);
    return dto;
  }

  private async toDtos(rows: Post[]): Promise<AdminPostDto[]> {
    const relations = await loadPostRelations(this.relationModels, rows);
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
