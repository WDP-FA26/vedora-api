import { ApiProperty } from '@nestjs/swagger';
import { CatalogRecipeDto } from './recipe-catalog.dto.js';

/** PUT/DELETE choose the state. No client identity or flags are accepted. */
export class RecipeFavoriteBodyDto {}

export class RecipeFavoriteStateDto {
  @ApiProperty({ format: 'uuid' }) recipeId!: string;
  @ApiProperty() isFavorite!: boolean;
}

export class FavoriteRecipeDto extends CatalogRecipeDto {
  @ApiProperty({ type: String, format: 'date-time' }) savedAt!: Date;
}
