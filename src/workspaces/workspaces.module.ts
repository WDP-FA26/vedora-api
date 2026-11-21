import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProfileSearchModule } from '../profiles/search/profile-search.module.js';
import { RestaurantMenuService } from './restaurant-menu.service.js';
import { RestaurantReviewsService } from './restaurant-reviews.service.js';
import { MenuSearchIndexService } from './search/menu-search-index.service.js';
import { MenuSearchService } from './search/menu-search.service.js';
import {
  AdminWorkspacesController,
  RestaurantsController,
  WorkspacesController,
} from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

@Module({
  imports: [AuthModule, ProfileSearchModule],
  controllers: [
    WorkspacesController,
    AdminWorkspacesController,
    RestaurantsController,
  ],
  providers: [
    WorkspacesService,
    MenuSearchIndexService,
    MenuSearchService,
    RestaurantMenuService,
    RestaurantReviewsService,
  ],
  exports: [
    RestaurantMenuService,
    RestaurantReviewsService,
    MenuSearchIndexService,
  ],
})
export class WorkspacesModule {}
