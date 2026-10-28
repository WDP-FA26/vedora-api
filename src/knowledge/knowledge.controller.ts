import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import type { AuthenticatedRequest } from '../auth/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CreateKnowledgeUploadDto } from './dto/create-knowledge-upload.dto.js';
import {
  CreateKnowledgeUploadResponseDto,
  KnowledgeDocumentResponseDto,
} from './dto/knowledge-document-response.dto.js';
import { KnowledgeService } from './knowledge.service.js';
import { ErrorBodyDto } from '../common/exceptions/error-body.dto.js';

// TODO: restrict to admins once users have roles; any signed-in user for now.
@ApiTags('knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('knowledge/documents')
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post()
  @ApiOperation({
    summary: 'Start a knowledge-base file upload',
    description:
      'Creates the document and returns a presigned URL; the browser PUTs the PDF straight to RustFS.',
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

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a document and its file' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.knowledgeService.remove(id);
  }
}
