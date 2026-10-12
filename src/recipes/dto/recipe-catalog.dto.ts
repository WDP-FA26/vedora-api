import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../common/pagination';
import { RecipeDetailDto, RecipeDto } from './recipe.dto';

export class RecipeCatalogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    default: false,
    description: 'Only recipes with every ingredient verified VEGAN',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  veganOnly: boolean = false;
  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Search titles, descriptions, ingredient names and aliases',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 2880,
    description:
      'Maximum prep + cook minutes; recipes with both times unknown are excluded',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value,
  )
  @IsInt()
  @Min(0)
  @Max(2880)
  maxMinutes?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Requires login and confirmed allergy information. Applies diet mode, exclusions, ingredient completeness and internal conflicts before paging; the saved day is checked when previewing or saving',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  suitableForMe: boolean = false;
}

export class CatalogRecipeDto extends RecipeDto {
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Prep + cook minutes; null when both are unknown',
  })
  totalMinutes!: number | null;
}

export class CatalogRecipeDetailDto extends RecipeDetailDto {
  @ApiProperty({ nullable: true, type: Number })
  totalMinutes!: number | null;
}
