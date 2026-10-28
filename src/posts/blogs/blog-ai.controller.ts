import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { UserThrottlerGuard } from '../../nutrition-chat/user-throttler.guard';
import { BlogAssistantService } from './ai/blog-assistant.service';
import {
  BlogAssistantChatDto,
  BlogAssistantQuotaDto,
} from '../dto/blog-ai.dto';

@ApiTags('blogs')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Authentication required' })
@UseGuards(JwtAuthGuard)
@Controller('blogs/ai')
export class BlogAiController {
  constructor(private readonly assistant: BlogAssistantService) {}

  @Get('quota')
  @ApiOperation({ summary: "Today's assistant and image allowance" })
  @ApiOkResponse({ type: BlogAssistantQuotaDto })
  quota(@Req() request: AuthenticatedRequest): Promise<BlogAssistantQuotaDto> {
    return this.assistant.quota(request.user.sub);
  }

  @Post('chat')
  @UseGuards(UserThrottlerGuard)
  // one user turn may take several requests: each editor tool the browser
  // answers resumes the turn
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Talk to the blog writing assistant',
    description:
      'Streams an AI SDK UI message stream (SSE) for `useChat`. Send the editor state with every request. Editor tools (`replaceSelection`, `replaceText`, `insertMarkdown`, `setTitle`, `insertImage`) have no server side: apply them in the editor after the user accepts, answer with `addToolOutput({ applied })`, and let `lastAssistantMessageIsCompleteWithToolCalls` resume the turn. `generateImage` and `editImage` run here and return a stored image URL.',
  })
  @ApiProduces('text/event-stream')
  @ApiOkResponse({
    description: [
      'UI message stream chunks (`start`, `text-delta`, `tool-input-available`, `tool-output-available`, `finish`, …). A refused message streams one fixed reply whose `start` chunk carries `messageMetadata: { refused: true }`.',
      '',
      'Editor tools (inputs → output the browser sends back):',
      '- `replaceSelection { markdown }`',
      '- `replaceText { find, replace }`: `find` occurs once in the draft',
      "- `insertMarkdown { markdown, position: 'cursor' | 'end' | 'after', after? }`",
      '- `setTitle { title }`',
      "- `insertImage { url, alt, position: 'cursor' | 'end' | 'after', after? }`",
      "- output: `{ applied: boolean, error?: 'NO_SELECTION' | 'NOT_FOUND' | 'AMBIGUOUS' | 'STALE', reason? }`",
      '',
      "Server tools: `generateImage { prompt, aspectRatio: '1:1' | '4:3' | '3:4' | '16:9' }` and `editImage { imageUrl, instruction }` output `{ url }` or `{ error: 'IMAGE_QUOTA_EXCEEDED' | 'IMAGE_PROMPT_REFUSED' | 'IMAGE_NOT_OWNED' | 'IMAGE_FAILED' }`; `searchKnowledge { query }` outputs passages.",
    ].join('\n'),
  })
  @ApiBadRequestResponse({
    description: '`BLOG_AI_INVALID_MESSAGES`: malformed history or tool parts',
  })
  @ApiNotFoundResponse({ description: '`blogId` is not one of your blogs' })
  @ApiTooManyRequestsResponse({
    description:
      '`AI_QUOTA_EXCEEDED` when the daily allowance is spent, or more than 30 requests a minute',
  })
  @ApiServiceUnavailableResponse({
    description: 'The moderation model failed or timed out',
  })
  async chat(
    @Req() request: AuthenticatedRequest,
    @Body() dto: BlogAssistantChatDto,
    @Res() response: Response,
  ): Promise<void> {
    const abort = new AbortController();
    response.on('close', () => abort.abort());

    await pipeUIMessageStreamToResponse({
      response,
      stream: await this.assistant.stream(request.user.sub, dto, abort.signal),
    });
  }
}
