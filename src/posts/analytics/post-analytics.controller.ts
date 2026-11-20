import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../../auth-core/auth.types.js';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { ErrorBodyDto } from '../../common/exceptions/error-body.dto.js';
import {
  ListPostAnalyticsQueryDto,
  PostAnalyticsPageDto,
  PostAnalyticsRangeQueryDto,
  PostAnalyticsSummaryDto,
} from './dto/post-analytics.dto.js';
import { PostAnalyticsService } from './post-analytics.service.js';

@ApiTags('post-analytics')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@ApiBadRequestResponse({
  type: ErrorBodyDto,
  description:
    'Invalid/partial date range, more than 90 days or unsupported query field',
})
@UseGuards(JwtAuthGuard)
@Controller('analytics/posts')
export class PostAnalyticsController {
  constructor(private readonly analytics: PostAnalyticsService) {}

  @Get('summary')
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary:
      "The caller's post analytics for a Bangkok date range, with the previous period of the same length",
  })
  @ApiOkResponse({ type: PostAnalyticsSummaryDto })
  summary(
    @Req() request: AuthenticatedRequest,
    @Query() query: PostAnalyticsRangeQueryDto,
  ): Promise<PostAnalyticsSummaryDto> {
    return this.analytics.summary(request.user.sub, query);
  }

  @Get()
  @Header('Cache-Control', 'private, no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    summary: "The caller's published posts with their counts in the range",
  })
  @ApiOkResponse({ type: PostAnalyticsPageDto })
  list(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListPostAnalyticsQueryDto,
  ): Promise<PostAnalyticsPageDto> {
    return this.analytics.listPosts(request.user.sub, query);
  }
}
