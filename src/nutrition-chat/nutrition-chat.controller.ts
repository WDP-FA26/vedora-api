import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { pipeUIMessageStreamToResponse } from 'ai';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { NutritionChatDto } from './dto/nutrition-chat.dto';
import { NutritionChatService } from './nutrition-chat.service';
import { UserThrottlerGuard } from './user-throttler.guard';

@ApiTags('nutrition-chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, UserThrottlerGuard)
@Controller('nutrition-chat')
export class NutritionChatController {
  constructor(private readonly nutritionChatService: NutritionChatService) {}

  @Post()
  @ApiOperation({
    summary: 'Ask the nutrition assistant',
    description:
      'Streams the reply as an AI SDK UI message stream (SSE) for `useChat`.',
  })
  @ApiTooManyRequestsResponse({ description: 'More than 10 messages a minute' })
  @ApiServiceUnavailableResponse({
    description: 'The moderation model failed or timed out',
  })
  async chat(
    @Body() dto: NutritionChatDto,
    @Res() response: Response,
  ): Promise<void> {
    const abort = new AbortController();
    response.on('close', () => abort.abort());

    await pipeUIMessageStreamToResponse({
      response,
      stream: await this.nutritionChatService.stream(
        dto.messages,
        abort.signal,
      ),
    });
  }
}
