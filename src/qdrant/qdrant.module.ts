import { Global, Module } from '@nestjs/common';
import { QdrantService } from './qdrant.service.js';

@Global()
@Module({
  providers: [QdrantService],
  exports: [QdrantService],
})
export class QdrantModule {}
