import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProfileSearchModule } from '../profiles/search/profile-search.module.js';
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
  providers: [WorkspacesService],
})
export class WorkspacesModule {}
