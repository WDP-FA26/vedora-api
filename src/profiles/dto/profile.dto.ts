import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProfileImageKind } from '../../mongo/models.js';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto.js';
import { Transform } from 'class-transformer';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

export class ProfileSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ nullable: true, type: String }) bio!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
  @ApiProperty({ nullable: true, type: String }) coverUrl!: string | null;
  @ApiProperty() isProfessional!: boolean;
}

export class ProfileDto extends ProfileSummaryDto {
  @ApiProperty() createdAt!: Date;
  @ApiProperty() postCount!: number;
  @ApiProperty() followerCount!: number;
  @ApiProperty() followingCount!: number;
}

export class ProfileListDto {
  @ApiProperty({ type: [ProfileSummaryDto] }) items!: ProfileSummaryDto[];
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) nextCursor!:
    string | null;
}

export class ProfileSearchItemDto extends ProfileSummaryDto {
  @ApiProperty() isFollowing!: boolean;
}

export class ProfileSearchPageDto {
  @ApiProperty({ type: [ProfileSearchItemDto] }) items!: ProfileSearchItemDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class ProfileRelationshipDto {
  @ApiProperty() isFollowing!: boolean;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: runtimeConfig.AUTH_FULL_NAME_MAX_LENGTH })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.AUTH_FULL_NAME_MAX_LENGTH)
  fullName?: string;

  @ApiPropertyOptional({
    maxLength: runtimeConfig.PROFILE_BIO_MAX_LENGTH,
    description: 'Empty string clears the bio; null is rejected',
  })
  // Only an absent bio skips validation: null must fail IsString with 400.
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(trim)
  @IsString()
  @MaxLength(runtimeConfig.PROFILE_BIO_MAX_LENGTH)
  bio?: string;
}

export const PROFILE_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export class CreateProfileImageUploadDto {
  @ApiProperty({ enum: ProfileImageKind })
  @IsEnum(ProfileImageKind)
  kind!: ProfileImageKind;

  @ApiProperty({ enum: PROFILE_IMAGE_TYPES })
  @IsIn(PROFILE_IMAGE_TYPES)
  contentType!: (typeof PROFILE_IMAGE_TYPES)[number];

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

export class ProfileImageUploadDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: PresignedUploadDto,
    description:
      'PUT the image here within the hour, then activate the upload by id',
  })
  upload!: PresignedUploadDto;
}
