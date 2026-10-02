import { Module } from '@nestjs/common';
import { MediaModule } from '../media/media.module';
import { PostInteractionsController } from './post-interactions.controller';
import { PostInteractionsService } from './post-interactions.service';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';

@Module({
  imports: [MediaModule],
  controllers: [PostsController, PostInteractionsController],
  providers: [PostsService, PostInteractionsService],
})
export class PostsModule {}
