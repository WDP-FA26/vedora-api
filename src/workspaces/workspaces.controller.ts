import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '../mongo/models.js';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
  OptionalAuthenticatedRequest,
} from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { OptionalJwtAuthGuard } from '../auth-core/optional-jwt-auth.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import { PersonalSessionGuard } from '../auth-core/personal-session.guard.js';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
} from '../common/pagination/index.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';
import {
  AddWorkspaceMemberDto,
  AdminWorkspaceDetailDto,
  AdminWorkspaceDto,
  CreateWorkspaceDto,
  CreateWorkspaceProofUploadDto,
  RestaurantDetailsDto,
  RestaurantPinListDto,
  RestaurantsInViewQueryDto,
  ReviewWorkspaceDto,
  WorkspaceDetailDto,
  WorkspaceDto,
  WorkspaceProofUploadDto,
  WorkspacesQueryDto,
} from './dto/workspace.dto.js';
import {
  CreateMenuImageUploadDto,
  CreateRestaurantMenuItemDto,
  MenuImageUploadDto,
  RestaurantMenuItemDto,
  RestaurantMenuListDto,
  RestaurantMenuSearchPageDto,
  SearchRestaurantMenuQueryDto,
  UpdateRestaurantMenuItemDto,
} from './dto/restaurant-menu.dto.js';
import {
  ListRestaurantReviewsQueryDto,
  RestaurantReviewMutationResponseDto,
  RestaurantReviewPageDto,
  RestaurantReviewSummaryDto,
  UpsertRestaurantReviewDto,
} from './dto/restaurant-review.dto.js';
import { RestaurantMenuService } from './restaurant-menu.service.js';
import { RestaurantReviewsService } from './restaurant-reviews.service.js';
import { TaxCodeLookupDto } from './dto/tax-code-lookup.dto.js';
import { TaxCodeLookupService } from './tax-code-lookup.service.js';
import { WorkspacesService } from './workspaces.service.js';

const personOf = (user: AuthenticatedUser): string => user.actorId ?? user.sub;

@ApiTags('workspaces')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  type: ErrorBodyDto,
  description: 'Authentication required',
})
@UseGuards(JwtAuthGuard)
@Controller('workspaces')
export class WorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly menu: RestaurantMenuService,
  ) {}

  @Get('mine')
  @ApiOperation({ summary: 'Pages you own or manage, newest first' })
  @ApiOkResponse({ type: [WorkspaceDto] })
  mine(@Req() request: AuthenticatedRequest): Promise<WorkspaceDto[]> {
    return this.workspaces.mine(personOf(request.user));
  }

  @Post('proofs/uploads')
  @UseGuards(PersonalSessionGuard)
  @ApiOperation({ summary: 'Get a presigned upload for a page proof image' })
  @ApiCreatedResponse({ type: WorkspaceProofUploadDto })
  createProofUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateWorkspaceProofUploadDto,
  ): Promise<WorkspaceProofUploadDto> {
    return this.workspaces.createProofUpload(request.user.sub, dto);
  }

  @Post()
  @UseGuards(PersonalSessionGuard)
  @ApiOperation({
    summary: 'Apply to open a restaurant page',
    description:
      'The page stays PENDING until an admin approves it; only then does the page account exist.',
  })
  @ApiCreatedResponse({ type: WorkspaceDetailDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'USERNAME_TAKEN or PROOF_NOT_UPLOADED',
  })
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateWorkspaceDto,
  ): Promise<WorkspaceDetailDto> {
    return this.workspaces.create(request.user.sub, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'A page you manage, with its members' })
  @ApiOkResponse({ type: WorkspaceDetailDto })
  detail(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<WorkspaceDetailDto> {
    return this.workspaces.detail(personOf(request.user), id);
  }

  @Patch(':id/details')
  @ApiOperation({
    summary: "Change the restaurant's address, map pin, phone or website",
    description:
      "Any member. Name, username, bio and avatar are edited on the page's profile.",
  })
  @ApiOkResponse({ type: WorkspaceDetailDto })
  updateDetails(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RestaurantDetailsDto,
  ): Promise<WorkspaceDetailDto> {
    return this.workspaces.updateDetails(personOf(request.user), id, dto);
  }

  @Post(':id/resubmit')
  @UseGuards(PersonalSessionGuard)
  @ApiOperation({ summary: 'Send a rejected page for review again (owner)' })
  @ApiOkResponse({ type: WorkspaceDetailDto })
  @HttpCode(HttpStatus.OK)
  resubmit(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateWorkspaceDto,
  ): Promise<WorkspaceDetailDto> {
    return this.workspaces.resubmit(request.user.sub, id, dto);
  }

  @Post(':id/members')
  @ApiOperation({ summary: 'Add a manager by username (owner)' })
  @ApiCreatedResponse({ type: WorkspaceDetailDto })
  @ApiForbiddenResponse({
    type: ErrorBodyDto,
    description: 'WORKSPACE_OWNER_REQUIRED',
  })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'ALREADY_MEMBER or WORKSPACE_NOT_APPROVED',
  })
  addMember(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddWorkspaceMemberDto,
  ): Promise<WorkspaceDetailDto> {
    return this.workspaces.addMember(personOf(request.user), id, dto);
  }

  @Delete(':id/members/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a manager (owner), or leave the page (manager)',
    description: "The removed person's page sessions end immediately.",
  })
  @ApiNoContentResponse()
  async removeMember(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<void> {
    await this.workspaces.removeMember(personOf(request.user), id, userId);
  }

  @Get(':id/menu')
  @ApiOperation({ summary: 'List menu items for a restaurant page you manage' })
  @ApiOkResponse({ type: RestaurantMenuListDto })
  listMenu(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RestaurantMenuListDto> {
    return this.menu.listForWorkspace(personOf(request.user), id);
  }

  @Post(':id/menu/image-uploads')
  @ApiOperation({ summary: 'Get a presigned upload for a menu dish photo' })
  @ApiCreatedResponse({ type: MenuImageUploadDto })
  createMenuImageUpload(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateMenuImageUploadDto,
  ): Promise<MenuImageUploadDto> {
    return this.menu.createImageUpload(personOf(request.user), id, dto);
  }

  @Post(':id/menu')
  @ApiOperation({ summary: 'Create a dish on the restaurant menu' })
  @ApiCreatedResponse({ type: RestaurantMenuItemDto })
  createMenuItem(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateRestaurantMenuItemDto,
  ): Promise<RestaurantMenuItemDto> {
    return this.menu.create(personOf(request.user), id, dto);
  }

  @Patch(':id/menu/:itemId')
  @ApiOperation({ summary: 'Update a dish on the restaurant menu' })
  @ApiOkResponse({ type: RestaurantMenuItemDto })
  updateMenuItem(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdateRestaurantMenuItemDto,
  ): Promise<RestaurantMenuItemDto> {
    return this.menu.update(personOf(request.user), id, itemId, dto);
  }

  @Delete(':id/menu/:itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a dish from the restaurant menu' })
  @ApiNoContentResponse()
  async removeMenuItem(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ): Promise<void> {
    await this.menu.remove(personOf(request.user), id, itemId);
  }
}

@ApiTags('workspaces')
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
@Controller('admin/workspaces')
export class AdminWorkspacesController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly taxCodes: TaxCodeLookupService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List page applications (admin only)' })
  @ApiPaginatedResponse(AdminWorkspaceDto)
  findAll(
    @Query() query: WorkspacesQueryDto,
  ): Promise<PaginatedResponseDto<AdminWorkspaceDto>> {
    return this.workspaces.adminList(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'A page application with signed proof image URLs (admin only)',
  })
  @ApiOkResponse({ type: AdminWorkspaceDetailDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminWorkspaceDetailDto> {
    return this.workspaces.adminDetail(id);
  }

  @Get(':id/tax-code')
  @ApiOperation({
    summary:
      "The tax department's public data for an application's company tax code (admin only)",
    description:
      'Looks up 10-digit and 10-3 codes (VietQR, cached a day). Personal 12-digit codes are not public: NOT_APPLICABLE. A failed or rate-limited lookup is UNAVAILABLE, not an error.',
  })
  @ApiOkResponse({ type: TaxCodeLookupDto })
  taxCode(@Param('id', ParseUUIDPipe) id: string): Promise<TaxCodeLookupDto> {
    return this.taxCodes.forWorkspace(id);
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve or reject a pending page (admin only)',
    description: 'Approving creates the page account.',
  })
  @ApiOkResponse({ type: AdminWorkspaceDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'WORKSPACE_NOT_REVIEWABLE or USERNAME_TAKEN',
  })
  review(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewWorkspaceDto,
  ): Promise<AdminWorkspaceDto> {
    return this.workspaces.review(id, request.user.sub, dto);
  }
}

@ApiTags('workspaces')
@Controller('restaurants')
export class RestaurantsController {
  constructor(
    private readonly workspaces: WorkspacesService,
    private readonly menu: RestaurantMenuService,
    private readonly reviews: RestaurantReviewsService,
  ) {}

  @Get()
  @ApiOperation({
    summary:
      'Approved restaurants, optionally filtered by map viewport; sorted nearest-first when user coords are sent, otherwise A-Z (public)',
  })
  @ApiOkResponse({ type: RestaurantPinListDto })
  inView(
    @Query() query: RestaurantsInViewQueryDto,
  ): Promise<RestaurantPinListDto> {
    return this.workspaces.inView(query);
  }

  @Get('menu/search')
  @ApiOperation({ summary: 'Search available restaurant dishes (public)' })
  @ApiOkResponse({ type: RestaurantMenuSearchPageDto })
  searchMenu(
    @Query() query: SearchRestaurantMenuQueryDto,
  ): Promise<RestaurantMenuSearchPageDto> {
    return this.menu.search(query);
  }

  @Get(':pageUserId/menu')
  @ApiOperation({ summary: 'Public menu of a restaurant page' })
  @ApiOkResponse({ type: RestaurantMenuListDto })
  publicMenu(
    @Param('pageUserId', ParseUUIDPipe) pageUserId: string,
  ): Promise<RestaurantMenuListDto> {
    return this.menu.listPublic(pageUserId);
  }

  @Get(':pageUserId/reviews')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({
    summary: 'Star rating summary and reviews of a restaurant page',
    security: [{}, { bearer: [] }],
  })
  @ApiOkResponse({ type: RestaurantReviewPageDto })
  listReviews(
    @Param('pageUserId', ParseUUIDPipe) pageUserId: string,
    @Query() query: ListRestaurantReviewsQueryDto,
    @Req() request: OptionalAuthenticatedRequest,
  ): Promise<RestaurantReviewPageDto> {
    return this.reviews.list(pageUserId, query, request.user?.sub);
  }

  @Put(':pageUserId/reviews/me')
  @UseGuards(JwtAuthGuard, PersonalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create or update your review for a restaurant' })
  @ApiOkResponse({ type: RestaurantReviewMutationResponseDto })
  upsertMyReview(
    @Param('pageUserId', ParseUUIDPipe) pageUserId: string,
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpsertRestaurantReviewDto,
  ): Promise<RestaurantReviewMutationResponseDto> {
    return this.reviews.upsertMine(pageUserId, request.user.sub, dto);
  }

  @Delete(':pageUserId/reviews/me')
  @UseGuards(JwtAuthGuard, PersonalSessionGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Delete your review for a restaurant' })
  @ApiOkResponse({ type: RestaurantReviewSummaryDto })
  deleteMyReview(
    @Param('pageUserId', ParseUUIDPipe) pageUserId: string,
    @Req() request: AuthenticatedRequest,
  ): Promise<RestaurantReviewSummaryDto> {
    return this.reviews.deleteMine(pageUserId, request.user.sub);
  }
}
