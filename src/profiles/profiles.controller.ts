import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
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
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ProfileImageKind } from '@prisma/client';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CursorPaginationQueryDto } from '../common/pagination';
import {
  CreateProfileImageUploadDto,
  ProfileDto,
  ProfileImageUploadDto,
  ProfileListDto,
  ProfileRelationshipDto,
  UpdateProfileDto,
} from './dto/profile.dto';
import { ProfilesService } from './profiles.service';

@ApiTags('profiles')
@Controller('profiles')
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get your public profile' })
  @ApiOkResponse({ type: ProfileDto })
  me(@Req() request: AuthenticatedRequest): Promise<ProfileDto> {
    return this.profiles.findOne(request.user.sub);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Edit your display name and bio' })
  @ApiOkResponse({ type: ProfileDto })
  updateMe(
    @Req() request: AuthenticatedRequest,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileDto> {
    return this.profiles.updateMe(request.user.sub, dto);
  }

  @Post('me/images/uploads')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get a scoped Vercel Blob client token for an avatar or cover',
  })
  @ApiCreatedResponse({ type: ProfileImageUploadDto })
  createImageUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateProfileImageUploadDto,
  ): Promise<ProfileImageUploadDto> {
    return this.profiles.createImageUpload(request.user.sub, dto);
  }

  @Post('me/images/:uploadId/activate')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Use a confirmed image upload on your profile' })
  @ApiOkResponse({ type: ProfileDto })
  activateImage(
    @Req() request: AuthenticatedRequest,
    @Param('uploadId', ParseUUIDPipe) uploadId: string,
  ): Promise<ProfileDto> {
    return this.profiles.activateImage(request.user.sub, uploadId);
  }

  @Delete('me/images/:kind')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Remove your current avatar or cover' })
  @ApiOkResponse({ type: ProfileDto })
  clearImage(
    @Req() request: AuthenticatedRequest,
    @Param('kind', new ParseEnumPipe(ProfileImageKind)) kind: ProfileImageKind,
  ): Promise<ProfileDto> {
    return this.profiles.clearImage(request.user.sub, kind);
  }

  @Get(':id/followers')
  @ApiOperation({ summary: "List a profile's followers" })
  @ApiOkResponse({ type: ProfileListDto })
  followers(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    return this.profiles.followers(id, query);
  }

  @Get(':id/following')
  @ApiOperation({ summary: 'List profiles this user follows' })
  @ApiOkResponse({ type: ProfileListDto })
  following(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CursorPaginationQueryDto,
  ): Promise<ProfileListDto> {
    return this.profiles.following(id, query);
  }

  @Get(':id/relationship')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Check whether you follow a profile' })
  @ApiOkResponse({ type: ProfileRelationshipDto })
  relationship(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ProfileRelationshipDto> {
    return this.profiles.relationship(id, request.user.sub);
  }

  @Put(':id/follow')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Follow a profile (idempotent)' })
  @ApiNoContentResponse()
  follow(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.profiles.follow(id, request.user.sub);
  }

  @Delete(':id/follow')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Unfollow a profile (idempotent)' })
  @ApiNoContentResponse()
  unfollow(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.profiles.unfollow(id, request.user.sub);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a public profile and its counts' })
  @ApiOkResponse({ type: ProfileDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ProfileDto> {
    return this.profiles.findOne(id);
  }
}
