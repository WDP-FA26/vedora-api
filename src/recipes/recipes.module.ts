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

@Module({
  controllers: [
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
    DietaryService,
  ],
  exports: [IncompatibilityRulesService, DietaryService],
})
export class RecipesModule {}
