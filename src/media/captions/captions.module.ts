import { Module } from '@nestjs/common';
import { CaptionService } from './caption.service.js';
import { TranscriptionService } from './transcription.service.js';

@Module({
  providers: [CaptionService, TranscriptionService],
  exports: [CaptionService],
})
export class CaptionsModule {}
