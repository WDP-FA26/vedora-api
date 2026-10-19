import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class AccountOperationDto {
  @ApiProperty({
    minimum: 0,
    description: 'Current accountVersion of the target',
  })
  @IsInt()
  @Min(0)
  @Max(2_147_483_646)
  expectedVersion!: number;

  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
