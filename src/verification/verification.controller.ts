import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  ApiPaginatedResponse,
  PaginatedResponseDto,
} from '../common/pagination';
import {
  AdminVerificationRequestDetailDto,
  AdminVerificationRequestDto,
  CreateProofUploadDto,
  CreateVerificationRequestDto,
  MyVerificationDto,
  ProofUploadDto,
  ReviewVerificationRequestDto,
  VerificationRequestDto,
  VerificationRequestsQueryDto,
} from './dto/verification.dto';
import { VerificationService } from './verification.service';

@ApiTags('verification')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('verification')
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Get your professional status and most recent request',
  })
  @ApiOkResponse({ type: MyVerificationDto })
  mine(@Req() request: AuthenticatedRequest): Promise<MyVerificationDto> {
    return this.verification.mine(request.user.sub);
  }

  @Post('proofs/uploads')
  @ApiOperation({ summary: 'Get a presigned upload for a proof image' })
  @ApiCreatedResponse({ type: ProofUploadDto })
  createProofUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateProofUploadDto,
  ): Promise<ProofUploadDto> {
    return this.verification.createProofUpload(request.user.sub, dto);
  }

  @Post('requests')
  @ApiOperation({
    summary: 'Ask to be verified as a professional',
    description:
      'Takes a statement and the ids of uploaded proof images. One request can be pending at a time.',
  })
  @ApiCreatedResponse({ type: VerificationRequestDto })
  @ApiConflictResponse({
    description:
      'ALREADY_VERIFIED, REQUEST_PENDING or PROOF_NOT_UPLOADED (see `code`)',
  })
  submit(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateVerificationRequestDto,
  ): Promise<VerificationRequestDto> {
    return this.verification.submit(request.user.sub, dto);
  }

  @Get('requests')
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List verification requests (admin only)' })
  @ApiForbiddenResponse({ description: 'Insufficient account permissions' })
  @ApiPaginatedResponse(AdminVerificationRequestDto)
  findAll(
    @Query() query: VerificationRequestsQueryDto,
  ): Promise<PaginatedResponseDto<AdminVerificationRequestDto>> {
    return this.verification.findAll(query);
  }

  @Get('requests/:id')
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Get a request with signed proof image URLs (admin only)',
  })
  @ApiForbiddenResponse({ description: 'Insufficient account permissions' })
  @ApiOkResponse({ type: AdminVerificationRequestDetailDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminVerificationRequestDetailDto> {
    return this.verification.findOne(id);
  }

  @Post('requests/:id/review')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN)
  @ApiOperation({
    summary: 'Approve or reject a pending request (admin only)',
    description: 'Approving marks the applicant as a professional.',
  })
  @ApiForbiddenResponse({ description: 'Insufficient account permissions' })
  @ApiOkResponse({ type: AdminVerificationRequestDto })
  @ApiConflictResponse({ description: 'The request was already reviewed' })
  review(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewVerificationRequestDto,
  ): Promise<AdminVerificationRequestDto> {
    return this.verification.review(id, request.user.sub, dto);
  }
}
