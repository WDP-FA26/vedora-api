import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { Roles } from '../../auth-core/roles.decorator.js';
import { RolesGuard } from '../../auth-core/roles.guard.js';
import { ErrorBodyDto } from '../../common/exceptions/error-body.dto.js';
import { StateConflictException } from '../../common/exceptions/state-conflict.exception.js';
import { PostEvidenceService } from '../../media/post-evidence.service.js';
import { UserRole } from '../../mongo/models.js';
import { AdminPostDto } from '../dto/admin-post.dto.js';
import { AdminPostsService } from './admin-posts.service.js';

@ApiTags('admin')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiForbiddenResponse({
  type: ErrorBodyDto,
  description: 'Insufficient account permissions',
})
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('admin/posts')
export class AdminPostEvidenceController {
  constructor(
    private readonly adminPosts: AdminPostsService,
    private readonly evidence: PostEvidenceService,
  ) {}

  @Post(':id/moderation/evidence')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run the reviewer model again on a flagged post',
    description:
      'The reviewer model runs on its own for every post System 1 flags. Call this to retry a FAILED review or review an older post. On a post held in PROCESSING (MODERATION_MODE=enforce) the outcome is applied; on a PENDING_REVIEW or REJECTED post it is only recorded in `moderation.route`. Takes up to a minute and costs a little.',
  })
  @ApiOkResponse({ type: AdminPostDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description:
      '`POST_NOT_REVIEWABLE`: the post is not flagged (held, PENDING_REVIEW or REJECTED), or was judged again meanwhile',
  })
  async explain(@Param('id', ParseUUIDPipe) id: string): Promise<AdminPostDto> {
    // 404 for a post that does not exist, before paying for a model call.
    await this.adminPosts.findOne(id);
    const stored = await this.evidence.explain(id);
    if (!stored) {
      throw new StateConflictException(
        'POST_NOT_REVIEWABLE',
        'Only a post waiting for review or a rejected one can be explained',
      );
    }
    return this.adminPosts.findOne(id);
  }
}
