import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth-core/auth.types.js';
import { JwtAuthGuard } from '../auth-core/jwt-auth.guard.js';
import { Roles } from '../auth-core/roles.decorator.js';
import { RolesGuard } from '../auth-core/roles.guard.js';
import { UserRole } from '../mongo/models.js';
import { CreateKnowledgeUploadDto } from './dto/create-knowledge-upload.dto.js';
import {
  CreateKnowledgeUploadResponseDto,
  KnowledgeDocumentResponseDto,
  KnowledgeFileUrlResponseDto,
  KnowledgePageResponseDto,
} from './dto/knowledge-document-response.dto.js';
import { ReviewKnowledgeDocumentDto } from './dto/review-knowledge-document.dto.js';
import { UpdateKnowledgePageDto } from './dto/update-knowledge-page.dto.js';
import { KnowledgeService } from './knowledge.service.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

@ApiTags('knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN)
@Controller('knowledge/documents')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a knowledge-base file upload',
    description:
      'Creates the document and returns a presigned URL; the browser PUTs the PDF straight to object storage and calls POST /:id/confirm.',
  })
  @ApiUnsupportedMediaTypeResponse({
    description: 'The file is not a PDF',
  })
  @ApiPayloadTooLargeResponse({ description: 'Over MAX_KNOWLEDGE_FILE_MB' })
  @ApiServiceUnavailableResponse({
    type: ErrorBodyDto,
    description: 'File storage is not configured',
  })
  createUpload(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateKnowledgeUploadDto,
  ): Promise<CreateKnowledgeUploadResponseDto> {
    return this.knowledgeService.createUpload(
      request.user.sub,
      dto.filename,
      dto.sizeBytes,
    );
  }

  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm a PDF upload and start OCR extraction',
    description:
      'Verifies the uploaded PDF exists in storage via HeadObject and starts OCR extraction. Idempotent once no longer WAITING_UPLOAD.',
  })
  confirmUpload(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.knowledgeService.confirmUpload(id);
  }

  @Get()
  @ApiOperation({ summary: 'List knowledge-base documents, newest first' })
  findAll(): Promise<KnowledgeDocumentResponseDto[]> {
    return this.knowledgeService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a document and its ingestion status' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.knowledgeService.findOne(id);
  }

  @Get(':id/pages')
  @ApiOperation({
    summary: 'OCR text of each page, for review',
    description:
      'Available for documents extracted after the review step existed. Older READY documents have no pages.',
  })
  listPages(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KnowledgePageResponseDto[]> {
    return this.knowledgeService.listPages(id);
  }

  @Patch(':id/pages/:page')
  @ApiOperation({
    summary: 'Correct the text of a page',
    description: 'Only while the document is AWAITING_REVIEW, else 409.',
  })
  updatePage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('page', ParseIntPipe) page: number,
    @Body() dto: UpdateKnowledgePageDto,
  ): Promise<KnowledgePageResponseDto> {
    return this.knowledgeService.updatePage(id, page, dto.text);
  }

  @Get(':id/file-url')
  @ApiOperation({
    summary: 'Presigned link to the original PDF',
    description: 'Open it with #page=N to compare a page with its OCR text.',
  })
  fileUrl(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KnowledgeFileUrlResponseDto> {
    return this.knowledgeService.fileUrl(id);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve the reviewed text and index it',
    description:
      'AWAITING_REVIEW to INDEXING, then READY. Poll the document. If indexing fails it returns to AWAITING_REVIEW with failureReason INDEXING_FAILED.',
  })
  approve(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewKnowledgeDocumentDto,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.knowledgeService.approve(
      request.user.sub,
      id,
      dto.note ?? null,
    );
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject the document without deleting it',
    description:
      'AWAITING_REVIEW to REJECTED. The file and pages are kept, nothing is indexed. Use DELETE to remove it.',
  })
  reject(
    @Req() request: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewKnowledgeDocumentDto,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.knowledgeService.reject(request.user.sub, id, dto.note ?? null);
  }

  @Post(':id/reopen')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Put a REJECTED document back in review' })
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<KnowledgeDocumentResponseDto> {
    return this.knowledgeService.reopen(id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a document, its file, pages and indexed points',
  })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.knowledgeService.remove(id);
  }
}
