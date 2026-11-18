import { Module } from '@nestjs/common';
import { ProfileSearchIndexService } from './profile-search-index.service.js';
import { ProfileSearchService } from './profile-search.service.js';

@Module({
  providers: [ProfileSearchIndexService, ProfileSearchService],
  exports: [ProfileSearchIndexService, ProfileSearchService],
})
export class ProfileSearchModule {}
