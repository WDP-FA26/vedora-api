import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AccountsService],
  exports: [UsersService, AccountsService],
})
export class UsersModule {}
