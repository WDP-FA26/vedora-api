import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProfileImageKind } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto';

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

export class ProfileRelationshipDto {
  @ApiProperty() isFollowing!: boolean;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  fullName?: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Empty string clears the bio',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
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
