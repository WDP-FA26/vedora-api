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
import type { AuthenticatedRequest } from '../auth/auth.types';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateKnowledgeUploadDto } from './dto/create-knowledge-upload.dto';
import {
  CreateKnowledgeUploadResponseDto,
  KnowledgeDocumentResponseDto,
} from './dto/knowledge-document-response.dto';
import { KnowledgeService } from './knowledge.service';

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
      'Creates the document and returns a Vercel Blob client token for its pathname. The browser uploads the file straight to Vercel Blob.',
  })
  @ApiUnsupportedMediaTypeResponse({
    description: 'No extractor handles the file extension',
  })
  @ApiPayloadTooLargeResponse({ description: 'Over MAX_KNOWLEDGE_FILE_MB' })
  @ApiServiceUnavailableResponse({
    description: 'Vercel Blob or its callback URL is not configured',
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
