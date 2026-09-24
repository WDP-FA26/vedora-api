import { ApiProperty } from '@nestjs/swagger';
import { MediaType } from '@prisma/client';
import { IsIn } from 'class-validator';

export class CreateUploadDto {
  @ApiProperty({
    enum: [MediaType.VIDEO],
    description: 'Only VIDEO for now; IMAGE comes later.',
  })
  @IsIn([MediaType.VIDEO])
  type!: MediaType;
}
