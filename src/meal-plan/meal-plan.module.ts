import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module.js';
import { RecipesModule } from '../recipes/recipes.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { CalorieEstimator } from './meal-log/calorie-estimator.js';
import { MealLogController } from './meal-log/meal-log.controller.js';
import { MealLogService } from './meal-log/meal-log.service.js';
import { MealPlanController } from './meal-plan.controller.js';
import { MealPlanService } from './meal-plan.service.js';
import { MealPlannerChatHistoryService } from './meal-planner-chat-history.service.js';
import { MealPlannerChatService } from './meal-planner-chat.service.js';
import { ShoppingListController } from './shopping-list.controller.js';
import { ShoppingListService } from './shopping-list.service.js';

@Module({
  imports: [
    RecipesModule,
    KnowledgeModule,
    SubscriptionsModule,
    WorkspacesModule,
  ],
  controllers: [MealPlanController, MealLogController, ShoppingListController],
  providers: [
    CalorieEstimator,
    MealLogService,
    MealPlanService,
    MealPlannerChatHistoryService,
    MealPlannerChatService,
    ShoppingListService,
  ],
})
export class MealPlanModule {}
