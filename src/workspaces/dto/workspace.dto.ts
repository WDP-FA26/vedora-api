import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsBoolean,
  IsEmail,
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
  Validate,
  ValidateIf,
  ValidateNested,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  BusinessForm,
  LegalEntityType,
  VegetarianLevel,
  VerificationStatus,
  WorkspaceMemberRole,
  WorkspaceProofKind,
  WorkspaceRejectReason,
} from '../../mongo/models.js';
import {
  isVnProvinceCode,
  VN_PROVINCE_CODES,
  wardName,
  type VnProvinceCode,
} from '../vn-admin-units.js';
import { isWellFormedCitizenId } from '../citizen-id.js';
import { PaginationQueryDto } from '../../common/pagination/index.js';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto.js';
import {
  MAX_REVIEW_NOTE_LENGTH,
  MAX_STATEMENT_LENGTH,
  PROOF_IMAGE_TYPES,
  type ReviewDecision,
} from '../../verification/dto/verification.dto.js';

export const MAX_ADDRESS_LENGTH = 300;
export const MAX_PHONE_LENGTH = 30;
export const MAX_WEBSITE_LENGTH = 300;
export const MAX_LEGAL_NAME_LENGTH = 200;
export const MAX_PERSON_NAME_LENGTH = 100;
export const MAX_OTHER_PLATFORM_URLS = 5;
export const MAX_WORKSPACE_PROOFS = 10;

const IDENTITY_AND_STOREFRONT = [
  WorkspaceProofKind.ID_FRONT,
  WorkspaceProofKind.ID_BACK,
  WorkspaceProofKind.STOREFRONT,
] as const;

export const REQUIRED_PROOF_KINDS: Record<
  LegalEntityType,
  readonly WorkspaceProofKind[]
> = {
  [LegalEntityType.COMPANY]: [
    ...IDENTITY_AND_STOREFRONT,
    WorkspaceProofKind.BUSINESS_LICENSE,
  ],
  [LegalEntityType.HOUSEHOLD]: [
    ...IDENTITY_AND_STOREFRONT,
    WorkspaceProofKind.BUSINESS_LICENSE,
  ],
  [LegalEntityType.INDIVIDUAL]: IDENTITY_AND_STOREFRONT,
};

const COMPANY_TAX_CODE = /^\d{10}(-\d{3})?$/;
const CITIZEN_ID = /^\d{12}$/;
const HOUSEHOLD_TAX_CODE = /^(\d{10}(-\d{3})?|\d{12})$/;
export const MAX_RESTAURANTS_IN_VIEW = 200;

const REVIEW_DECISIONS = [
  VerificationStatus.APPROVED,
  VerificationStatus.REJECTED,
] as const;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const compactTaxCode = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/[\s.]/g, '') : value;

const trimLower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const blankToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  return trimmed;
};

export class CreateWorkspaceProofUploadDto {
  @ApiProperty({
    enum: WorkspaceProofKind,
    description: 'What the image shows; each kind has its own slot in the form',
  })
  @IsEnum(WorkspaceProofKind)
  kind!: WorkspaceProofKind;

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

export class RestaurantPlaceDto {
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
}

export class RestaurantDetailsDto extends RestaurantPlaceDto {
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

function taxCodeFormat(entityType: LegalEntityType): RegExp {
  if (entityType === LegalEntityType.COMPANY) return COMPANY_TAX_CODE;
  if (entityType === LegalEntityType.INDIVIDUAL) return CITIZEN_ID;
  return HOUSEHOLD_TAX_CODE;
}

function isLegalEntityType(value: unknown): value is LegalEntityType {
  return Object.values(LegalEntityType).some((type) => type === value);
}

@ValidatorConstraint({ name: 'taxCodeForEntity' })
class TaxCodeForEntity implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'string') return false;
    const holder: unknown = args.object;
    if (typeof holder !== 'object' || holder === null) return false;
    const entityType: unknown = Reflect.get(holder, 'entityType');
    if (!isLegalEntityType(entityType)) return true;
    if (!taxCodeFormat(entityType).test(value)) return false;
    if (value.length === 12) return isWellFormedCitizenId(value);
    return true;
  }

  defaultMessage(): string {
    return 'taxCode must be 10 digits (10-3 for a branch) for a company, a real 12-digit citizen ID for an individual, or either for a household';
  }
}

@ValidatorConstraint({ name: 'wardOfProvince' })
class WardOfProvince implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (typeof value !== 'string') return false;
    const holder: unknown = args.object;
    if (typeof holder !== 'object' || holder === null) return false;
    const provinceCode: unknown = Reflect.get(holder, 'provinceCode');
    if (!isVnProvinceCode(provinceCode)) return true;
    return wardName(provinceCode, value) !== null;
  }

  defaultMessage(): string {
    return 'wardCode must be a ward or commune of provinceCode';
  }
}

const needsLegalName = (dto: WorkspaceLegalDto): boolean =>
  dto.entityType !== LegalEntityType.INDIVIDUAL;

export class WorkspaceLegalDto {
  @ApiProperty({ enum: LegalEntityType })
  @IsEnum(LegalEntityType)
  entityType!: LegalEntityType;

  @ApiProperty({
    example: '0312345678',
    description:
      'COMPANY: 10 digits, or 10-3 for a branch. HOUSEHOLD: that, or a 12-digit citizen ID. INDIVIDUAL: the 12-digit citizen ID. Spaces and dots are removed.',
  })
  @Transform(compactTaxCode)
  @IsString()
  @Validate(TaxCodeForEntity)
  taxCode!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_LEGAL_NAME_LENGTH,
    description:
      'Company or household business name; required unless INDIVIDUAL, ignored for INDIVIDUAL',
  })
  @ValidateIf(needsLegalName)
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LEGAL_NAME_LENGTH)
  legalName?: string | null;

  @ApiProperty({
    maxLength: MAX_ADDRESS_LENGTH,
    description:
      'Registered address, or the permanent address of an individual',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_ADDRESS_LENGTH)
  legalAddress!: string;

  @ApiProperty({ maxLength: MAX_PERSON_NAME_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PERSON_NAME_LENGTH)
  representativeName!: string;

  @ApiProperty({ format: 'email' })
  @Transform(trimLower)
  @IsEmail()
  contactEmail!: string;
}

export class CreateWorkspaceDto extends RestaurantPlaceDto {
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
    enum: VN_PROVINCE_CODES,
    description: 'Province or city code',
  })
  @IsIn(VN_PROVINCE_CODES)
  provinceCode!: VnProvinceCode;

  @ApiProperty({
    example: '00004',
    description:
      'Official 5-digit code of a ward, commune or special zone of provinceCode',
  })
  @IsString()
  @Validate(WardOfProvince)
  wardCode!: string;

  @ApiProperty({ enum: BusinessForm })
  @IsEnum(BusinessForm)
  businessForm!: BusinessForm;

  @ApiProperty({ enum: VegetarianLevel })
  @IsEnum(VegetarianLevel)
  vegetarianLevel!: VegetarianLevel;

  @ApiProperty({
    maxLength: MAX_PHONE_LENGTH,
    description:
      'Required; the admin calls this number to confirm the application',
  })
  @Transform(trim)
  @IsString()
  @Matches(/^[0-9+().\s-]+$/, { message: 'phone has invalid characters' })
  @Matches(/^(\D*\d){8,}\D*$/, { message: 'phone needs at least 8 digits' })
  @MaxLength(MAX_PHONE_LENGTH)
  phone!: string;

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

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_OTHER_PLATFORM_URLS,
    description:
      'The restaurant on Google Maps, ShopeeFood, GrabFood, Facebook…',
  })
  @IsOptional()
  @ArrayMaxSize(MAX_OTHER_PLATFORM_URLS)
  @ArrayUnique()
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { each: true },
  )
  @MaxLength(MAX_WEBSITE_LENGTH, { each: true })
  otherPlatformUrls?: string[];

  @ApiProperty({ type: WorkspaceLegalDto })
  @ValidateNested()
  @Type(() => WorkspaceLegalDto)
  legal!: WorkspaceLegalDto;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_STATEMENT_LENGTH,
    description: 'Who you are at this restaurant (owner, manager…)',
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(MAX_STATEMENT_LENGTH)
  statement?: string | null;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: MAX_WORKSPACE_PROOFS,
    description:
      'Uploaded proofs. The kinds in REQUIRED_PROOF_KINDS for legal.entityType must all be there.',
  })
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_WORKSPACE_PROOFS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  proofIds!: string[];

  @ApiProperty({
    enum: [true],
    description:
      'The details and documents are true and the applicant represents the restaurant',
  })
  @IsIn([true], { message: 'confirmsAccuracy must be true' })
  confirmsAccuracy!: true;

  @ApiProperty({
    enum: [true],
    description: 'Vedora may use the documents only to review this application',
  })
  @IsIn([true], { message: 'consentsToReview must be true' })
  consentsToReview!: true;
}

export class RestaurantLocationDto {
  @ApiProperty() address!: string;
  @ApiProperty() longitude!: number;
  @ApiProperty() latitude!: number;
  @ApiProperty({ type: String, nullable: true }) phone!: string | null;
  @ApiProperty({ type: String, nullable: true }) website!: string | null;
}

export class RestaurantProfileFieldsDto extends RestaurantLocationDto {
  @ApiProperty({ type: String, nullable: true, enum: VN_PROVINCE_CODES })
  provinceCode!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Official ward code; null on applications made before it',
  })
  wardCode!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Ward name (from wardCode, or as typed on older applications)',
  })
  ward!: string | null;
  @ApiProperty({ enum: BusinessForm, nullable: true })
  businessForm!: BusinessForm | null;
  @ApiProperty({ enum: VegetarianLevel, nullable: true })
  vegetarianLevel!: VegetarianLevel | null;
  @ApiProperty({ type: [String] }) otherPlatformUrls!: string[];
  @ApiProperty({ type: String, nullable: true }) statement!: string | null;
}

export class WorkspaceLegalViewDto {
  @ApiProperty({ enum: LegalEntityType }) entityType!: LegalEntityType;
  @ApiProperty() taxCode!: string;
  @ApiProperty({ type: String, nullable: true }) legalName!: string | null;
  @ApiProperty() legalAddress!: string;
  @ApiProperty() representativeName!: string;
  @ApiProperty() contactEmail!: string;
}

export class WorkspaceMemberDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() username!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty({ enum: WorkspaceMemberRole }) role!: WorkspaceMemberRole;
  @ApiProperty() createdAt!: Date;
}

export class WorkspaceDto extends RestaurantProfileFieldsDto {
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
  @ApiProperty({ enum: VerificationStatus }) status!: VerificationStatus;
  @ApiProperty({ type: String, nullable: true }) reviewNote!: string | null;
  @ApiProperty({ enum: WorkspaceRejectReason, nullable: true })
  rejectReason!: WorkspaceRejectReason | null;
  @ApiProperty({ type: Date, nullable: true }) reviewedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() proofCount!: number;
  @ApiProperty({ enum: WorkspaceMemberRole, description: 'Your role' })
  role!: WorkspaceMemberRole;
  @ApiProperty({
    type: WorkspaceLegalViewDto,
    nullable: true,
    description:
      'Shown to the owner only (it can hold their citizen ID); null for managers and older applications',
  })
  legal!: WorkspaceLegalViewDto | null;
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

export class WorkspaceReviewChecklistDto {
  @ApiProperty({
    description: 'The name on the ID card matches the representative',
  })
  @IsBoolean()
  identityMatches!: boolean;

  @ApiProperty({
    description: 'The tax code looks up to this legal name and is active',
  })
  @IsBoolean()
  taxCodeVerified!: boolean;

  @ApiProperty({ description: 'The storefront photo matches the address' })
  @IsBoolean()
  storefrontMatches!: boolean;

  @ApiProperty({
    description: 'The admin called the phone number and it was confirmed',
  })
  @IsBoolean()
  phoneConfirmed!: boolean;
}

export class AdminWorkspaceDto extends RestaurantProfileFieldsDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  pageUserId!: string | null;
  @ApiProperty() username!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) bio!: string | null;
  @ApiProperty({ enum: VerificationStatus }) status!: VerificationStatus;
  @ApiProperty({ type: String, nullable: true }) reviewNote!: string | null;
  @ApiProperty({ enum: WorkspaceRejectReason, nullable: true })
  rejectReason!: WorkspaceRejectReason | null;
  @ApiProperty({ type: WorkspaceReviewChecklistDto, nullable: true })
  reviewChecklist!: WorkspaceReviewChecklistDto | null;
  @ApiProperty({ type: Date, nullable: true }) reviewedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: Date, nullable: true }) committedAt!: Date | null;
  @ApiProperty() proofCount!: number;
  @ApiProperty({
    type: WorkspaceLegalViewDto,
    nullable: true,
    description: 'Null on applications made before the 3-step form',
  })
  legal!: WorkspaceLegalViewDto | null;
  @ApiProperty({
    type: AdminWorkspaceApplicantDto,
    nullable: true,
    description: 'The owner; null if their account was deleted',
  })
  owner!: AdminWorkspaceApplicantDto | null;
}

export class WorkspaceProofDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: WorkspaceProofKind }) kind!: WorkspaceProofKind;
  @ApiProperty({ description: 'Signed read URL, valid for ten minutes' })
  url!: string;
}

export enum WorkspaceWarningCode {
  SAME_TAX_CODE = 'SAME_TAX_CODE',
  NEARBY_PAGE = 'NEARBY_PAGE',
  RECENT_REJECTION = 'RECENT_REJECTION',
}

export class WorkspaceWarningPageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: VerificationStatus }) status!: VerificationStatus;
}

export class WorkspaceWarningDto {
  @ApiProperty({ enum: WorkspaceWarningCode }) code!: WorkspaceWarningCode;
  @ApiProperty({ type: [WorkspaceWarningPageDto] })
  workspaces!: WorkspaceWarningPageDto[];
}

export class AdminWorkspaceDetailDto extends AdminWorkspaceDto {
  @ApiProperty({ type: [WorkspaceProofDto] }) proofs!: WorkspaceProofDto[];
  @ApiProperty({ type: [WorkspaceWarningDto] })
  warnings!: WorkspaceWarningDto[];
}

export class WorkspacesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: VerificationStatus })
  @IsOptional()
  @IsEnum(VerificationStatus)
  status?: VerificationStatus;
}

const isRejecting = (dto: ReviewWorkspaceDto): boolean =>
  dto.decision === VerificationStatus.REJECTED;

export class ReviewWorkspaceDto {
  @ApiProperty({ enum: REVIEW_DECISIONS })
  @IsIn(REVIEW_DECISIONS)
  decision!: ReviewDecision;

  @ApiPropertyOptional({
    enum: WorkspaceRejectReason,
    description: 'Required when rejecting',
  })
  @ValidateIf(isRejecting)
  @IsEnum(WorkspaceRejectReason)
  rejectReason?: WorkspaceRejectReason;

  @ApiPropertyOptional({
    maxLength: MAX_REVIEW_NOTE_LENGTH,
    description: 'Shown to the owner; required when rejectReason is OTHER',
  })
  @Transform(trim)
  @ValidateIf(
    (dto: ReviewWorkspaceDto) =>
      dto.rejectReason === WorkspaceRejectReason.OTHER || !!dto.note,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_REVIEW_NOTE_LENGTH)
  note?: string;

  @ApiPropertyOptional({
    type: WorkspaceReviewChecklistDto,
    description:
      'Required, all true, to approve an application made with the 3-step form',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => WorkspaceReviewChecklistDto)
  checklist?: WorkspaceReviewChecklistDto;
}

const hasBounds = (dto: RestaurantsInViewQueryDto): boolean =>
  dto.minLng !== undefined ||
  dto.minLat !== undefined ||
  dto.maxLng !== undefined ||
  dto.maxLat !== undefined;

const hasUserCoords = (dto: RestaurantsInViewQueryDto): boolean =>
  dto.userLng !== undefined || dto.userLat !== undefined;

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
    description:
      'Distance in meters when user coordinates were sent; else null',
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
