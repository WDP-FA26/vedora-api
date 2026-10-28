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
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '../mongo/models.js';
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { UserResponseDto } from '../auth/dto/auth-response.dto.js';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
} from '../common/pagination/index.js';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { UpdateUserRoleDto } from './dto/update-user-role.dto.js';
import { UpdateUserStatusDto } from './dto/update-user-status.dto.js';
import { UsersQueryDto } from './dto/users-query.dto.js';
import { AccountsService } from './accounts.service.js';
import { type PublicUser } from './public-user.js';
import { UsersService } from './users.service.js';

@ApiTags('users')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@ApiForbiddenResponse({ description: 'Insufficient account permissions' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly accounts: AccountsService,
  ) {}

  @Post()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Create a user (admin only)' })
  create(@Body() dto: CreateUserDto): Promise<PublicUser> {
    return this.accounts.createWithPassword(dto);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List users with page-based pagination' })
  @ApiPaginatedResponse(UserResponseDto)
  findAll(
    @Query() query: UsersQueryDto,
  ): Promise<PaginatedResponseDto<PublicUser>> {
    return this.usersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get your account, or any account as an admin' })
  findOne(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PublicUser> {
    return this.usersService.findOne(id, request.user);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update your account, or any account as an admin' })
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<PublicUser> {
    return this.usersService.update(id, dto, request.user);
  }

  @Patch(':id/role')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'Change an account role (admin only)' })
  @ApiConflictResponse({ description: 'Stale version or final ACTIVE admin' })
  updateRole(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserRoleDto,
  ): Promise<PublicUser> {
    return this.usersService.updateRole(id, dto, request.user);
  }

  @Patch(':id/status')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Suspend or reactivate a verified account (admin only)',
  })
  @ApiConflictResponse({
    description: 'Stale version, invalid transition or final ACTIVE admin',
  })
  updateStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserStatusDto,
  ): Promise<PublicUser> {
    return this.usersService.updateStatus(id, dto, request.user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete your account, or any account as an admin' })
  @ApiConflictResponse({ description: 'Cannot delete the final ACTIVE admin' })
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.usersService.remove(id, request.user);
  }
}
