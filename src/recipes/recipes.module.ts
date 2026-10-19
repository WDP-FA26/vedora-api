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

@Module({
  controllers: [
    RecipesController,
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
  ],
  exports: [IncompatibilityRulesService, DietaryService],
})
export class RecipesModule {}
