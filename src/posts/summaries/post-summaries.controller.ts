import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { ErrorBodyDto } from '../../common/exceptions/error-body.dto.js';
import { ResourceNotFoundException } from '../../common/exceptions/resource-not-found.exception.js';
import { Post, PostStatus, type PostSummary } from '../../mongo/models.js';
import { PostSummariesService } from './post-summaries.service.js';
import { PostSummaryDto } from './post-summary.dto.js';

function toDto(summary: PostSummary): PostSummaryDto {
  return {
    postId: summary.postId,
    status: summary.status,
    language: summary.language,
    summary: summary.summary,
    recipe: summary.recipe
      ? {
          title: summary.recipe.title,
          description: summary.recipe.description,
          tag: summary.recipe.tag,
          servings: summary.recipe.servings,
          prepMinutes: summary.recipe.prepMinutes,
          cookMinutes: summary.recipe.cookMinutes,
          ingredients: summary.recipe.ingredients.map((ingredient) => ({
            name: ingredient.name,
            quantity: ingredient.quantity,
            unit: ingredient.unit,
            note: ingredient.note,
          })),
          steps: [...summary.recipe.steps],
        }
      : null,
    commentId: summary.commentId,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

@ApiTags('posts')
@Controller('posts/:postId/summary')
export class PostSummariesController {
  constructor(
    private readonly summaries: PostSummariesService,
    @InjectModel(Post.name) private readonly posts: Model<Post>,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Read the Vedora AI summary and recipe draft of a published post',
  })
  @ApiOkResponse({ type: PostSummaryDto })
  @ApiNotFoundResponse({
    type: ErrorBodyDto,
    description: 'The post is not published, or was never picked up',
  })
  async findOne(
    @Param('postId', ParseUUIDPipe) postId: string,
  ): Promise<PostSummaryDto> {
    const published = await this.posts.exists({
      _id: postId,
      status: PostStatus.PUBLISHED,
    });
    if (!published)
      throw new ResourceNotFoundException('NOT_FOUND', 'Post not found');
    const summary = await this.summaries.findForPost(postId);
    if (!summary)
      throw new ResourceNotFoundException('NOT_FOUND', 'Summary not found');
    return toDto(summary);
  }
}
