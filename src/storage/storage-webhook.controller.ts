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
import { ProfilesService } from '../profiles/profiles.service';
import { StorageWebhookGuard } from './storage-webhook.guard';
import {
  StorageService,
  WebhookStorageTarget,
  type StorageEvent,
} from './storage.service';

@ApiExcludeController()
@Controller('webhooks/storage')
@UseGuards(StorageWebhookGuard)
export class StorageWebhookController {
  private readonly handlers: Record<
    WebhookStorageTarget,
    (key: string) => Promise<void>
  >;

  constructor(
    private readonly storage: StorageService,
    knowledge: KnowledgeService,
    profiles: ProfilesService,
  ) {
    this.handlers = {
      [WebhookStorageTarget.Knowledge]: (key) => knowledge.markUploaded(key),
      [WebhookStorageTarget.Profiles]: (key) => profiles.markImageUploaded(key),
    };
  }

  @Post(':target')
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(
    @Param('target', new ParseEnumPipe(WebhookStorageTarget))
    target: WebhookStorageTarget,
    @Body() body: StorageEvent,
  ): Promise<void> {
    await Promise.all(
      this.storage.parseEvent(target, body).map(this.handlers[target]),
    );
  }
}
