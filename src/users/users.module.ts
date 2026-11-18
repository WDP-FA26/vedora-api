import { Module } from '@nestjs/common';
import { ProfileSearchModule } from '../profiles/search/profile-search.module.js';
import { AccountsService } from './accounts.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [ProfileSearchModule],
  controllers: [UsersController],
  providers: [UsersService, AccountsService],
  exports: [UsersService, AccountsService],
})
export class UsersModule {}
