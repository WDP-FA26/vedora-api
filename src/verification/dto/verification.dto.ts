import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VerificationStatus } from '../../mongo/models';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto';

export const PROOF_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const MAX_PROOFS = 6;
export const MIN_STATEMENT_LENGTH = 20;
export const MAX_STATEMENT_LENGTH = 2000;
export const MAX_REVIEW_NOTE_LENGTH = 500;

const REVIEW_DECISIONS = [
  VerificationStatus.APPROVED,
  VerificationStatus.REJECTED,
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateProofUploadDto {
  @ApiProperty({ enum: PROOF_IMAGE_TYPES })
  @IsIn(PROOF_IMAGE_TYPES)
  contentType!: (typeof PROOF_IMAGE_TYPES)[number];

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;
}

export class ProofUploadDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({
    type: PresignedUploadDto,
    description: 'PUT the image here, then submit the request with this id',
  })
  upload!: PresignedUploadDto;
}

export class CreateVerificationRequestDto {
  @ApiProperty({
    minLength: MIN_STATEMENT_LENGTH,
    maxLength: MAX_STATEMENT_LENGTH,
    description: 'Where the applicant works and what backs their claim',
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
    description: 'Uploaded proof images, in display order',
  })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PROOFS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  proofIds!: string[];
}

export class VerificationRequestDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() statement!: string;
  @ApiProperty({ enum: VerificationStatus }) status!: VerificationStatus;
  @ApiProperty({ nullable: true, type: String }) reviewNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) reviewedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() proofCount!: number;
}

export class MyVerificationDto {
  @ApiProperty() isProfessional!: boolean;

  @ApiProperty({
    nullable: true,
    type: VerificationRequestDto,
    description: 'Your most recent request',
  })
  request!: VerificationRequestDto | null;
}

export class VerificationApplicantDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
}

export class AdminVerificationRequestDto extends VerificationRequestDto {
  @ApiProperty({ type: VerificationApplicantDto })
  user!: VerificationApplicantDto;
}

export class VerificationProofDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Signed read URL, valid for ten minutes' })
  url!: string;
}

export class AdminVerificationRequestDetailDto extends AdminVerificationRequestDto {
  @ApiProperty({ type: [VerificationProofDto] })
  proofs!: VerificationProofDto[];
}

export class VerificationRequestsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  status?: VerificationStatus;
}

export class ReviewVerificationRequestDto {
  @ApiProperty({ enum: REVIEW_DECISIONS })
  @IsIn(REVIEW_DECISIONS)
  decision!: ReviewDecision;

  @ApiPropertyOptional({
    maxLength: MAX_REVIEW_NOTE_LENGTH,
    description: 'Shown to the applicant; required when rejecting',
  })
  @Transform(trim)
  @ValidateIf(
    (dto: ReviewVerificationRequestDto) =>
      dto.decision === VerificationStatus.REJECTED || !!dto.note,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_REVIEW_NOTE_LENGTH)
  note?: string;
}
