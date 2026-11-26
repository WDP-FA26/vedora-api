import { Module } from '@nestjs/common';
import {
  AdminIncompatibilityRulesController,
  AdminIngredientGroupsController,
  AdminIngredientsController,
} from './admin-ingredients.controller.js';
import { AdminRecipeCategoriesController } from './admin-recipe-categories.controller.js';
import { AdminRecipesController } from './admin-recipes.controller.js';
import { DietaryController } from './dietary.controller.js';
import { DietaryService } from './dietary.service.js';
import { IncompatibilityRulesService } from './incompatibility-rules.service.js';
import { IngredientsService } from './ingredients.service.js';
import { RecipesService } from './recipes.service.js';
import { RecipeCategoriesService } from './recipe-categories.service.js';
import { RecipeCategoriesController } from './recipe-categories.controller.js';
import { RecipeCatalogService } from './recipe-catalog.service.js';
import { RecipeRelationsService } from './recipe-relations.service.js';
import { RecipesController } from './recipes.controller.js';
import { RecipeFavoritesService } from './recipe-favorites.service.js';
import { RecipeRatingsController } from './recipe-ratings.controller.js';
import { RecipeRatingsService } from './recipe-ratings.service.js';
import { RecipeDraftGenerator } from './drafts/recipe-draft.generator.js';
import { RecipeDraftsService } from './drafts/recipe-drafts.service.js';

@Module({
  controllers: [
    RecipesController,
    RecipeRatingsController,
    RecipeCategoriesController,
    AdminIngredientsController,
    AdminIngredientGroupsController,
    AdminIncompatibilityRulesController,
    AdminRecipeCategoriesController,
    AdminRecipesController,
    DietaryController,
  ],
  providers: [
    IngredientsService,
    RecipeCategoriesService,
    IncompatibilityRulesService,
    RecipesService,
    RecipeRelationsService,
    RecipeCatalogService,
    RecipeFavoritesService,
    DietaryService,
    RecipeRatingsService,
    RecipeDraftsService,
    RecipeDraftGenerator,
  ],
  exports: [IncompatibilityRulesService, DietaryService],
})
export class RecipesModule {}
