import { Global, Module } from '@nestjs/common';
import { MuxService } from './mux.service';

@Global()
@Module({
  providers: [MuxService],
  exports: [MuxService],
})
export class MuxModule {}
