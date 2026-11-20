import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus } from '../../mongo/models.js';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination/index.js';

/** Statuses an admin can list by; the system account is never listed. */
const LISTED_STATUSES = Object.values(AccountStatus).filter(
  (status) => status !== AccountStatus.SYSTEM,
);

export class UsersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ description: 'Search username, fullName or email' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(runtimeConfig.USERS_SEARCH_MAX_LENGTH)
  q?: string;

  @ApiPropertyOptional({ enum: LISTED_STATUSES })
  @IsOptional()
  @IsIn(LISTED_STATUSES)
  status?: AccountStatus;
}
