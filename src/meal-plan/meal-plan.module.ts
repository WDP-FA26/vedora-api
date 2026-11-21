import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { RecipesModule } from '../recipes/recipes.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { MealPlanController } from './meal-plan.controller.js';
import { MealPlanService } from './meal-plan.service.js';
import { MealPlannerChatHistoryService } from './meal-planner-chat-history.service.js';
import { MealPlannerChatService } from './meal-planner-chat.service.js';
import { ShoppingListController } from './shopping-list.controller.js';
import { ShoppingListService } from './shopping-list.service.js';

@Module({
  imports: [RecipesModule, KnowledgeModule, SubscriptionsModule, WorkspacesModule],
  controllers: [MealPlanController, ShoppingListController],
  providers: [
    MealPlanService,
    MealPlannerChatHistoryService,
    MealPlannerChatService,
    ShoppingListService,
  ],
})
export class MealPlanModule {}
