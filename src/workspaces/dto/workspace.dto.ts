import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsEnum,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { VerificationStatus, WorkspaceMemberRole } from '../../mongo/models.js';
import { PaginationQueryDto } from '../../common/pagination/index.js';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto.js';
import {
  MAX_PROOFS,
  MAX_REVIEW_NOTE_LENGTH,
  MAX_STATEMENT_LENGTH,
  MIN_STATEMENT_LENGTH,
  PROOF_IMAGE_TYPES,
  type ReviewDecision,
} from '../../verification/dto/verification.dto.js';

export const MAX_ADDRESS_LENGTH = 300;
export const MAX_PHONE_LENGTH = 30;
export const MAX_WEBSITE_LENGTH = 300;
/** Restaurants returned for one map viewport. */
export const MAX_RESTAURANTS_IN_VIEW = 200;

const REVIEW_DECISIONS = [
  VerificationStatus.APPROVED,
  VerificationStatus.REJECTED,
] as const;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/** Blank optional text is stored as null. */
const blankToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed;
};

export class CreateWorkspaceProofUploadDto {
  @ApiProperty({ enum: PROOF_IMAGE_TYPES })
  @IsIn(PROOF_IMAGE_TYPES)
  contentType!: (typeof PROOF_IMAGE_TYPES)[number];

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

export class WorkspaceProofUploadDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: PresignedUploadDto,
    description: 'PUT the image here, then send this id with the application',
  })
  upload!: PresignedUploadDto;
}

/** Where the restaurant is and how to reach it; members can change it later. */
export class RestaurantDetailsDto {
  @ApiProperty({ maxLength: MAX_ADDRESS_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ADDRESS_LENGTH)
  address!: string;

  @ApiProperty({ minimum: -180, maximum: 180 })
  @Type(() => Number)
  @IsLongitude()
  longitude!: number;

  @ApiProperty({ minimum: -90, maximum: 90 })
  @Type(() => Number)
  @IsLatitude()
  latitude!: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_PHONE_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @Matches(/^[0-9+().\s-]+$/, { message: 'phone has invalid characters' })
  @MaxLength(MAX_PHONE_LENGTH)
  phone?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_WEBSITE_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @MaxLength(MAX_WEBSITE_LENGTH)
  website?: string | null;
}

export class CreateWorkspaceDto extends RestaurantDetailsDto {
  @ApiProperty({ maxLength: runtimeConfig.AUTH_FULL_NAME_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.AUTH_FULL_NAME_MAX_LENGTH)
  name!: string;

  @ApiProperty({
    example: 'chay.an.lac',
    minLength: runtimeConfig.AUTH_USERNAME_MIN_LENGTH,
    maxLength: runtimeConfig.AUTH_USERNAME_MAX_LENGTH,
  })
  @Transform(trimLower)
  @IsString()
  @MinLength(runtimeConfig.AUTH_USERNAME_MIN_LENGTH)
  @MaxLength(runtimeConfig.AUTH_USERNAME_MAX_LENGTH)
  @Matches(/^[a-z0-9._-]+$/, {
    message:
      'username can only contain lowercase letters, numbers, dots, underscores and hyphens',
  })
  username!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: runtimeConfig.PROFILE_BIO_MAX_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(runtimeConfig.PROFILE_BIO_MAX_LENGTH)
  bio?: string | null;

  @ApiProperty({
    minLength: MIN_STATEMENT_LENGTH,
    maxLength: MAX_STATEMENT_LENGTH,
    description: 'Who you are at this restaurant and what the proofs show',
  })
  @Transform(trim)
  @IsString()
  @MinLength(MIN_STATEMENT_LENGTH)
  @MaxLength(MAX_STATEMENT_LENGTH)
  statement!: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_PROOFS,
    description:
      'Uploaded proof images (business licence, food safety certificate, storefront photo)',
  })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PROOFS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  proofIds!: string[];
}

export class RestaurantLocationDto {
  @ApiProperty() address!: string;
  @ApiProperty() longitude!: number;
  @ApiProperty() latitude!: number;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) website!: string | null;
}

export class WorkspaceMemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty({ enum: WorkspaceMemberRole }) role!: WorkspaceMemberRole;
  @ApiProperty() createdAt!: Date;
}

export class WorkspaceDto extends RestaurantLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The page account; null until an admin approves the page',
  })
  pageUserId!: string | null;
  @ApiProperty({
    description: "The page's username (its current one once approved)",
  })
  username!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) bio!: string | null;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty() statement!: string;
  @ApiProperty({ enum: VerificationStatus }) status!: VerificationStatus;
  @ApiProperty({ type: String, nullable: true }) reviewNote!: string | null;
  @ApiProperty({ type: Date, nullable: true }) reviewedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() proofCount!: number;
  @ApiProperty({ enum: WorkspaceMemberRole, description: 'Your role' })
  role!: WorkspaceMemberRole;
}

export class WorkspaceDetailDto extends WorkspaceDto {
  @ApiProperty({ type: [WorkspaceMemberDto] }) members!: WorkspaceMemberDto[];
}

export class AddWorkspaceMemberDto {
  @ApiProperty({ description: 'Username of the person to add as a manager' })
  @Transform(trimLower)
  @IsString()
  @MinLength(1)
  @MaxLength(runtimeConfig.AUTH_USERNAME_MAX_LENGTH)
  username!: string;
}

export class AdminWorkspaceApplicantDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
}

export class AdminWorkspaceDto extends RestaurantLocationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  pageUserId!: string | null;
  @ApiProperty() username!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) bio!: string | null;
  @ApiProperty() statement!: string;
  @ApiProperty({ enum: VerificationStatus }) status!: VerificationStatus;
  @ApiProperty({ type: String, nullable: true }) reviewNote!: string | null;
  @ApiProperty({ type: Date, nullable: true }) reviewedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() proofCount!: number;
  @ApiProperty({
    type: AdminWorkspaceApplicantDto,
    nullable: true,
    description: 'The owner; null if their account was deleted',
  })
  owner!: AdminWorkspaceApplicantDto | null;
}

export class WorkspaceProofDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Signed read URL, valid for ten minutes' })
  url!: string;
}

export class AdminWorkspaceDetailDto extends AdminWorkspaceDto {
  @ApiProperty({ type: [WorkspaceProofDto] }) proofs!: WorkspaceProofDto[];
}

export class WorkspacesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  status?: VerificationStatus;
}

export class ReviewWorkspaceDto {
  @ApiProperty({ enum: REVIEW_DECISIONS })
  @IsIn(REVIEW_DECISIONS)
  decision!: ReviewDecision;

  @ApiPropertyOptional({
    maxLength: MAX_REVIEW_NOTE_LENGTH,
    description: 'Shown to the owner; required when rejecting',
  })
  @Transform(trim)
  @ValidateIf(
    (dto: ReviewWorkspaceDto) =>
      dto.decision === VerificationStatus.REJECTED || !!dto.note,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_REVIEW_NOTE_LENGTH)
  note?: string;
}

const hasBounds = (dto: RestaurantsInViewQueryDto): boolean =>
  dto.minLng !== undefined ||
  dto.minLat !== undefined ||
  dto.maxLng !== undefined ||
  dto.maxLat !== undefined;

const hasUserCoords = (dto: RestaurantsInViewQueryDto): boolean =>
  dto.userLng !== undefined || dto.userLat !== undefined;

/** Optional map viewport (all 4 corners together) and optional user point for proximity sorting. */
export class RestaurantsInViewQueryDto {
  @ApiPropertyOptional({ minimum: -180, maximum: 180 })
  @ValidateIf(hasBounds)
  @Type(() => Number)
  @IsLongitude()
  minLng?: number;

  @ApiPropertyOptional({ minimum: -90, maximum: 90 })
  @ValidateIf(hasBounds)
  @Type(() => Number)
  @IsLatitude()
  minLat?: number;

  @ApiPropertyOptional({ minimum: -180, maximum: 180 })
  @ValidateIf(hasBounds)
  @Type(() => Number)
  @IsLongitude()
  maxLng?: number;

  @ApiPropertyOptional({ minimum: -90, maximum: 90 })
  @ValidateIf(hasBounds)
  @Type(() => Number)
  @IsLatitude()
  maxLat?: number;

  @ApiPropertyOptional({ minimum: -180, maximum: 180 })
  @ValidateIf(hasUserCoords)
  @Type(() => Number)
  @IsLongitude()
  userLng?: number;

  @ApiPropertyOptional({ minimum: -90, maximum: 90 })
  @ValidateIf(hasUserCoords)
  @Type(() => Number)
  @IsLatitude()
  userLat?: number;
}

export class RestaurantPinDto {
  @ApiProperty({ format: 'uuid', description: 'The page account id' })
  pageUserId!: string;
  @ApiProperty() username!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty() address!: string;
  @ApiProperty() longitude!: number;
  @ApiProperty() latitude!: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Distance in meters when user coordinates were sent; else null',
  })
  distanceMeters!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  averageRating!: number | null;
  @ApiProperty({ minimum: 0 })
  reviewCount!: number;
}

export class RestaurantPinListDto {
  @ApiProperty({ type: [RestaurantPinDto] }) items!: RestaurantPinDto[];
  @ApiProperty({
    description: `True when more than ${MAX_RESTAURANTS_IN_VIEW} restaurants matched; results are capped at ${MAX_RESTAURANTS_IN_VIEW}`,
  })
  truncated!: boolean;
}
