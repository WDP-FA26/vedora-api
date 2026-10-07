import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const MAX_NAME_LENGTH = 100;
export const MAX_ALIASES = 20;
export const MAX_GROUP_MEMBERS = 500;
export const MAX_TEXT_LENGTH = 500;

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const trimEach = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value)
    ? value.map((item: unknown) =>
        typeof item === 'string' ? item.trim() : item,
      )
    : value;

export class NamedRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class SaveIngredientDto {
  @ApiProperty({ maxLength: MAX_NAME_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_NAME_LENGTH)
  name!: string;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_ALIASES,
    description: 'Other names for the same ingredient',
  })
  @IsOptional()
  @Transform(trimEach)
  @IsArray()
  @ArrayMaxSize(MAX_ALIASES)
  @ArrayUnique()
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_NAME_LENGTH, { each: true })
  aliases?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  groupIds?: string[];
}

export class IngredientDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ type: [String] }) aliases!: string[];
  @ApiProperty({ type: [NamedRefDto] }) groups!: NamedRefDto[];
  @ApiProperty({ minimum: 0, description: 'Recipes that use it' })
  recipeCount!: number;
  @ApiProperty() createdAt!: Date;
}

export class SaveIngredientGroupDto {
  @ApiProperty({ maxLength: MAX_NAME_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_NAME_LENGTH)
  name!: string;

  @ApiPropertyOptional({ maxLength: MAX_TEXT_LENGTH })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_TEXT_LENGTH)
  description?: string;

  @ApiPropertyOptional({
    description: 'Offer the group to users as a food category they can avoid',
  })
  @IsOptional()
  @IsBoolean()
  dietary?: boolean;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_GROUP_MEMBERS)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  ingredientIds?: string[];
}

export class IngredientGroupDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() dietary!: boolean;
  @ApiProperty({ type: [NamedRefDto] }) ingredients!: NamedRefDto[];
  @ApiProperty() createdAt!: Date;
}

export const RULE_SIDE_KINDS = ['INGREDIENT', 'GROUP'] as const;
export type RuleSideKind = (typeof RULE_SIDE_KINDS)[number];

export class RuleSideInputDto {
  @ApiProperty({ enum: RULE_SIDE_KINDS })
  @IsIn(RULE_SIDE_KINDS)
  kind!: RuleSideKind;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  id!: string;
}

export class SaveIncompatibilityRuleDto {
  @ApiProperty({ type: RuleSideInputDto })
  @ValidateNested()
  @Type(() => RuleSideInputDto)
  a!: RuleSideInputDto;

  @ApiProperty({ type: RuleSideInputDto })
  @ValidateNested()
  @Type(() => RuleSideInputDto)
  b!: RuleSideInputDto;

  @ApiProperty({ maxLength: MAX_TEXT_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_TEXT_LENGTH)
  reason!: string;

  @ApiPropertyOptional({
    maxLength: MAX_TEXT_LENGTH,
    description: 'Where the claim comes from',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MAX_TEXT_LENGTH)
  source?: string;
}

export class RuleSideDto {
  @ApiProperty({ enum: RULE_SIDE_KINDS }) kind!: RuleSideKind;
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
}

export class IncompatibilityRuleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: RuleSideDto }) a!: RuleSideDto;
  @ApiProperty({ type: RuleSideDto }) b!: RuleSideDto;
  @ApiProperty() reason!: string;
  @ApiProperty({ nullable: true, type: String }) source!: string | null;
  @ApiProperty() createdAt!: Date;
}
