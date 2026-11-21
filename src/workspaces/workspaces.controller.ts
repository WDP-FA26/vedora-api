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
} from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
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
import { WorkspacesService } from './workspaces.service.js';

/** Pages are managed by the person, also while they act as one of their pages. */
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
  constructor(private readonly workspaces: WorkspacesService) {}

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
      'The page stays PENDING until an admin approves it; only then does the page account exist. One application can be pending per person.',
  })
  @ApiCreatedResponse({ type: WorkspaceDetailDto })
  @ApiConflictResponse({
    type: ErrorBodyDto,
    description: 'USERNAME_TAKEN, REQUEST_PENDING or PROOF_NOT_UPLOADED',
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
  constructor(private readonly workspaces: WorkspacesService) {}

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
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  @ApiOperation({
    summary: 'Approved restaurants inside a map viewport (public)',
  })
  @ApiOkResponse({ type: RestaurantPinListDto })
  inView(
    @Query() query: RestaurantsInViewQueryDto,
  ): Promise<RestaurantPinListDto> {
    return this.workspaces.inView(query);
  }
}
