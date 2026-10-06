import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { StorageWebhookGuard } from './storage-webhook.guard';
import {
  StorageService,
  StorageTarget,
  type StorageEvent,
} from './storage.service';

@ApiExcludeController()
@Controller('webhooks/storage')
@UseGuards(StorageWebhookGuard)
export class StorageWebhookController {
  private readonly handlers: Record<
    StorageTarget,
    (key: string) => Promise<void>
  >;

  constructor(
    private readonly storage: StorageService,
    knowledge: KnowledgeService,
  ) {
    this.handlers = {
      [StorageTarget.Knowledge]: (key) => knowledge.markUploaded(key),
      // Profile images still upload to Vercel Blob.
      [StorageTarget.Profiles]: () => Promise.resolve(),
    };
  }

  @Post(':target')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(
    @Param('target', new ParseEnumPipe(StorageTarget)) target: StorageTarget,
    @Body() body: StorageEvent,
  ): Promise<void> {
    await Promise.all(
      this.storage.parseEvent(target, body).map(this.handlers[target]),
    );
  }
}
