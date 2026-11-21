import { runtimeConfig } from '../../config/runtime-config.js';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PaginationLimitDto } from '../../common/pagination/index.js';
import { PresignedUploadDto } from '../../storage/presigned-upload.dto.js';

export const MAX_MENU_ITEM_NAME_LENGTH = 120;
export const MAX_MENU_ITEM_DESCRIPTION_LENGTH = 600;
export const MAX_MENU_ITEM_CATEGORY_LENGTH = 60;
export const MAX_MENU_ITEM_PRICE_VND = 100_000_000;
export const MAX_MENU_IMAGE_URL_LENGTH = 2048;
export const MAX_MENU_IMAGE_MB = 5;
export const MENU_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const MAX_MENU_SEARCH_RESULTS = runtimeConfig.POST_SEARCH_MAX_RESULTS;
export const MAX_MENU_SEARCH_QUERY_LENGTH =
  runtimeConfig.SEARCH_QUERY_MAX_LENGTH;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const blankToNull = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export class CreateMenuImageUploadDto {
  @ApiProperty({ enum: MENU_IMAGE_TYPES })
  @IsIn(MENU_IMAGE_TYPES)
  contentType!: (typeof MENU_IMAGE_TYPES)[number];

  @ApiProperty({ minimum: 1, maximum: MAX_MENU_IMAGE_MB * 1024 * 1024 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_MENU_IMAGE_MB * 1024 * 1024)
  sizeBytes!: number;
}

export class MenuImageUploadDto {
  @ApiProperty({
    type: PresignedUploadDto,
    description: 'PUT the image here, then send `url` as `imageUrl`',
  })
  upload!: PresignedUploadDto;

  @ApiProperty()
  url!: string;
}

export class CreateRestaurantMenuItemDto {
  @ApiProperty({ maxLength: MAX_MENU_ITEM_NAME_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MENU_ITEM_NAME_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_MENU_ITEM_DESCRIPTION_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(MAX_MENU_ITEM_DESCRIPTION_LENGTH)
  description?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_MENU_ITEM_CATEGORY_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(MAX_MENU_ITEM_CATEGORY_LENGTH)
  category?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: MAX_MENU_ITEM_PRICE_VND,
  })
  @IsOptional()
  @ValidateIf((_dto, value: unknown) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MENU_ITEM_PRICE_VND)
  priceVnd?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_MENU_IMAGE_URL_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(MAX_MENU_IMAGE_URL_LENGTH)
  imageUrl?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position?: number;
}

export class UpdateRestaurantMenuItemDto {
  @ApiPropertyOptional({ maxLength: MAX_MENU_ITEM_NAME_LENGTH })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_MENU_ITEM_NAME_LENGTH)
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_MENU_ITEM_DESCRIPTION_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(MAX_MENU_ITEM_DESCRIPTION_LENGTH)
  description?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_MENU_ITEM_CATEGORY_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsString()
  @MaxLength(MAX_MENU_ITEM_CATEGORY_LENGTH)
  category?: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: MAX_MENU_ITEM_PRICE_VND,
  })
  @IsOptional()
  @ValidateIf((_dto, value: unknown) => value !== null)
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MENU_ITEM_PRICE_VND)
  priceVnd?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_MENU_IMAGE_URL_LENGTH,
  })
  @IsOptional()
  @Transform(blankToNull)
  @ValidateIf((_dto, value: unknown) => value !== null)
  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(MAX_MENU_IMAGE_URL_LENGTH)
  imageUrl?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  position?: number;
}

export class RestaurantMenuItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) workspaceId!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  pageUserId!: string | null;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: String, nullable: true }) category!: string | null;
  @ApiProperty({ type: Number, nullable: true }) priceVnd!: number | null;
  @ApiProperty({ type: String, nullable: true }) imageUrl!: string | null;
  @ApiProperty() isAvailable!: boolean;
  @ApiProperty() position!: number;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class RestaurantMenuListDto {
  @ApiProperty({ type: [RestaurantMenuItemDto] })
  items!: RestaurantMenuItemDto[];
}

export class MenuDishRestaurantSummaryDto {
  @ApiProperty({ format: 'uuid' }) pageUserId!: string;
  @ApiProperty() username!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) avatarUrl!: string | null;
  @ApiProperty() address!: string;
  @ApiProperty() longitude!: number;
  @ApiProperty() latitude!: number;
  @ApiProperty({ type: Number, nullable: true }) averageRating!: number | null;
  @ApiProperty({ minimum: 0 }) reviewCount!: number;
}

export class RestaurantMenuSearchItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: String, nullable: true }) description!: string | null;
  @ApiProperty({ type: String, nullable: true }) category!: string | null;
  @ApiProperty({ type: Number, nullable: true }) priceVnd!: number | null;
  @ApiProperty({ type: String, nullable: true }) imageUrl!: string | null;
  @ApiProperty({ type: MenuDishRestaurantSummaryDto })
  restaurant!: MenuDishRestaurantSummaryDto;
}

export class SearchRestaurantMenuQueryDto extends PaginationLimitDto {
  @ApiProperty({
    minLength: 1,
    maxLength: MAX_MENU_SEARCH_QUERY_LENGTH,
    description:
      'Dish, category, description or restaurant keywords (accents optional)',
  })
  @Transform(({ value }) => {
    const input: unknown = value;
    return typeof input === 'string' ? input.trim() : input;
  })
  @IsString()
  @Length(1, MAX_MENU_SEARCH_QUERY_LENGTH)
  q!: string;

  @ApiPropertyOptional({
    description:
      '`nextCursor` from the previous response; omit for the first page',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_MENU_SEARCH_RESULTS)
  cursor?: number;
}

export class RestaurantMenuSearchPageDto {
  @ApiProperty({ type: [RestaurantMenuSearchItemDto] })
  items!: RestaurantMenuSearchItemDto[];

  @ApiProperty({ nullable: true, type: String })
  nextCursor!: string | null;
}
