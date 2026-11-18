import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import {
  MediaResponseDto,
  SignedUploadDto,
} from '../../media/dto/media-response.dto.js';
import { MAX_POST_BODY_LENGTH } from './create-post.dto.js';

export class CreatePostDraftDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Client generated ID; keep on retries/reloads',
  })
  @IsUUID('4')
  id!: string;

  @ApiProperty({ enum: ['POST', 'VIDEO'] })
  @IsIn(['POST', 'VIDEO'])
  kind!: 'POST' | 'VIDEO';
}

export class PostDraftVersionDto {
  @ApiProperty({ minimum: 0 })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class SavePostDraftDto extends PostDraftVersionDto {
  @ApiPropertyOptional({ maxLength: MAX_POST_BODY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_POST_BODY_LENGTH)
  body?: string;

  @ApiPropertyOptional({ maxLength: MAX_POST_BODY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_POST_BODY_LENGTH)
  title?: string;

  @ApiPropertyOptional({ maxLength: MAX_POST_BODY_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_POST_BODY_LENGTH)
  description?: string;
}

export class DraftUploadRequestDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Stable local file ID, also reused after reload',
  })
  @IsUUID('4')
  mediaId!: string;
}

export class PostDraftDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['POST', 'VIDEO'] }) kind!: 'POST' | 'VIDEO';
  @ApiProperty() body!: string;
  @ApiProperty() title!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ minimum: 0 }) version!: number;
  @ApiProperty() updatedAt!: Date;
  @ApiProperty({ type: [MediaResponseDto] }) media!: MediaResponseDto[];
}

export class PostDraftPageDto {
  @ApiProperty({ type: [PostDraftDto] }) items!: PostDraftDto[];
}

export class DraftUploadResponseDto {
  @ApiProperty({ type: PostDraftDto }) draft!: PostDraftDto;
  @ApiProperty({ type: MediaResponseDto }) media!: MediaResponseDto;
  @ApiProperty({ type: SignedUploadDto, nullable: true })
  upload!: SignedUploadDto | null;
}
