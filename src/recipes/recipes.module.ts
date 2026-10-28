import { Module } from '@nestjs/common';
import {
  AdminIncompatibilityRulesController,
  AdminIngredientGroupsController,
  AdminIngredientsController,
} from './admin-ingredients.controller.js';
import { AdminRecipesController } from './admin-recipes.controller.js';
import { DietaryController } from './dietary.controller.js';
import { DietaryService } from './dietary.service.js';
import { IncompatibilityRulesService } from './incompatibility-rules.service.js';
import { IngredientsService } from './ingredients.service.js';
import { RecipesService } from './recipes.service.js';
import { RecipeCatalogService } from './recipe-catalog.service.js';
import { RecipeRelationsService } from './recipe-relations.service.js';
import { RecipesController } from './recipes.controller.js';
import { RecipeFavoritesService } from './recipe-favorites.service.js';
import { RecipeRatingsController } from './recipe-ratings.controller.js';
import { RecipeRatingsService } from './recipe-ratings.service.js';

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
    RecipeRelationsService,
    RecipeCatalogService,
    RecipeFavoritesService,
    DietaryService,
    RecipeRatingsService,
  ],
  exports: [IncompatibilityRulesService, DietaryService],
})
export class RecipesModule {}
