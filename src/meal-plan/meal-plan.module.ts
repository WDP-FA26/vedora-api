import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { RecipesModule } from '../recipes/recipes.module';
import { MealPlanController } from './meal-plan.controller';
import { MealPlanService } from './meal-plan.service';
import { MealPlannerChatService } from './meal-planner-chat.service';
import { ShoppingListController } from './shopping-list.controller';
import { ShoppingListService } from './shopping-list.service';

@Module({
  imports: [RecipesModule, KnowledgeModule],
  controllers: [MealPlanController, ShoppingListController],
  providers: [MealPlanService, MealPlannerChatService, ShoppingListService],
})
export class MealPlanModule {}
