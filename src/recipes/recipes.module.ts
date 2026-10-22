import { Module } from '@nestjs/common';
import {
  AdminIncompatibilityRulesController,
  AdminIngredientGroupsController,
  AdminIngredientsController,
} from './admin-ingredients.controller';
import { AdminRecipesController } from './admin-recipes.controller';
import { DietaryController } from './dietary.controller';
import { DietaryService } from './dietary.service';
import { IncompatibilityRulesService } from './incompatibility-rules.service';
import { IngredientsService } from './ingredients.service';
import { RecipesService } from './recipes.service';
import { RecipeCatalogService } from './recipe-catalog.service';
import { RecipesController } from './recipes.controller';
import { RecipeFavoritesService } from './recipe-favorites.service';
import { RecipeRatingsController } from './recipe-ratings.controller';
import { RecipeRatingsService } from './recipe-ratings.service';

@Module({
  controllers: [
    RecipesController,
    RecipeRatingsController,
    AdminIngredientsController,
    AdminIngredientGroupsController,
    AdminIncompatibilityRulesController,
    AdminRecipesController,
    DietaryController,
  ],
  providers: [
    IngredientsService,
    IncompatibilityRulesService,
    RecipesService,
    RecipeCatalogService,
    RecipeFavoritesService,
    DietaryService,
    RecipeRatingsService,
  ],
  exports: [IncompatibilityRulesService, DietaryService],
})
export class RecipesModule {}
