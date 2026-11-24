import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth-core/jwt-auth.guard.js';
import { PersonalSessionGuard } from '../../auth-core/personal-session.guard.js';
import type { AuthenticatedRequest } from '../../auth-core/auth.types.js';
import { PostReportsService } from './post-reports.service.js';
import {
  PostReportEvidenceService,
  REPORT_EVIDENCE_MAX_BYTES,
  type EvidenceFile,
} from './post-report-evidence.service.js';

@ApiTags('posts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PersonalSessionGuard)
@Controller('posts/:postId/report/evidence')
export class PostReportEvidenceController {
  constructor(
    private readonly reports: PostReportsService,
    private readonly evidence: PostReportEvidenceService,
  ) {}
  @Post()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      properties: { id: { type: 'string', format: 'uuid' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: REPORT_EVIDENCE_MAX_BYTES, files: 1, fields: 0 },
    }),
  )
  async upload(
    @Req() request: AuthenticatedRequest,
    @Param('postId', ParseUUIDPipe) postId: string,
    @UploadedFile() file?: EvidenceFile,
  ) {
    await this.reports.assertReportable(postId, request.user.sub);
    return this.evidence.upload(request.user.sub, postId, file);
  }
}
