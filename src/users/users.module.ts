import { Module } from '@nestjs/common';
import { AccountsService } from './accounts.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, AccountsService],
  exports: [UsersService, AccountsService],
})
export class UsersModule {}
