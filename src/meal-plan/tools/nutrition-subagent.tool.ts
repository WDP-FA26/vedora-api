import { Logger } from '@nestjs/common';
import { isStepCount, type LanguageModel, tool, ToolLoopAgent } from 'ai';
import { z } from 'zod';
import type { KnowledgeSearchService } from '../../knowledge/retrieval/knowledge-search.service.js';
import { searchKnowledgeTool } from '../../knowledge/tools/search-knowledge.tool.js';
import type { NutritionProfileDto } from '../../recipes/dto/dietary.dto.js';
import type { MealPlanService } from '../meal-plan.service.js';
import { searchRecipesTool } from './search-recipes.tool.js';
import { webSearchTool } from './web-search.tool.js';

const logger = new Logger('NutritionSubagentTool');
const SUBAGENT_MAX_STEPS = 6;
const SUBAGENT_MAX_OUTPUT_TOKENS = 1200;

function subagentInstructions(
  nutrition: NutritionProfileDto | null | undefined,
  avoidedTerms: readonly string[],
): string {
  const kcalLine =
    nutrition && nutrition.dailyCalorieTarget !== null
      ? `Mục tiêu người dùng: ~${nutrition.dailyCalorieTarget} kcal/ngày (vùng ${nutrition.dailyCalorieMin}–${nutrition.dailyCalorieMax} kcal, mục tiêu ${nutrition.effectiveGoal ?? 'cân đối'}).`
      : 'Người dùng chưa khai báo chỉ số cơ thể chi tiết.';
  const avoidedLine =
    avoidedTerms.length > 0
      ? `Thực phẩm tránh/kiêng: ${avoidedTerms.join(', ')}.`
      : 'Không có thực phẩm kiêng bắt buộc.';

  return `Bạn là Chuyên gia Dinh dưỡng Thực vật (Subagent hỗ trợ Trợ lý Vedora). Nhiệm vụ của bạn là tra cứu tự do, nhanh chóng và thực tế để trả kết quả tổng hợp lại cho Trợ lý chính.

Ngữ cảnh người dùng:
- ${kcalLine}
- ${avoidedLine}

Quyền & Cách làm việc tự do:
- Dùng \`webSearch\` ngay khi cần tra cứu calo, protein, vi chất (sắt, canxi, B12, omega-3), khẩu phần món ăn ngoài hàng, đồ ăn nhanh hoặc nguyên liệu chưa có trên Vedora. Không cần xin phép lại.
- Chỉ gọi \`searchKnowledge\` nếu thực sự cần tài liệu nội bộ, tối đa 1 lần; không lặp lại vô ích khi \`webSearch\` có câu trả lời trực tiếp hơn.
- Dùng \`searchRecipes\` để tìm món chay thật trong kho Vedora (lấy đúng \`id\`, tên món, \`~kcal/suất\`) phù hợp với ngân sách calo còn thiếu hoặc nhóm chất đang thiếu.
- Trả lời bằng tiếng Việt súc tích (khoảng 120–220 từ), nêu rõ con số ước tính tham khảo, phần calo còn lại nếu có món ăn ngoài, mẹo kết hợp thực vật (Vitamin C + Sắt, tách trà/cà phê), và liệt kê gợi ý mã món Vedora cụ thể (tên + id + ~kcal) nếu có để Trợ lý chính xếp thẳng vào lịch.`;
}

/**
 * Delegates external nutrition / street-food lookup and remaining calorie
 * math to a dedicated subagent equipped with unrestricted OpenRouter web search.
 */
export function consultNutritionSubagentTool(
  model: LanguageModel,
  mealPlan: MealPlanService,
  knowledge: KnowledgeSearchService,
  userId: string,
  nutrition?: NutritionProfileDto | null,
  avoidedTerms: readonly string[] = [],
) {
  return tool({
    description:
      'Consult the dedicated Nutrition & Web Research Subagent for external street foods, packaged vegan snacks/drinks, micronutrient questions (iron/calcium/B12), or multi-dish calorie budget balancing using web search plus the Vedora recipe catalog. Runs autonomously and returns a concise structured synthesis.',
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .max(1000)
        .describe(
          'What needs deeper nutrition analysis, external food calorie lookup, or menu balancing advice',
        ),
      externalFoods: z
        .array(z.string().min(1).max(200))
        .max(10)
        .optional()
        .describe(
          'Optional outside foods/drinks eaten or asked about (e.g. ["bún bò Huế chay ngoài quán", "trà sữa yến mạch"])',
        ),
      remainingCaloriesBudget: z
        .number()
        .int()
        .min(0)
        .max(4500)
        .optional()
        .describe('Approximate remaining kcal budget if already known'),
    }),
    execute: async (
      { question, externalFoods, remainingCaloriesBudget },
      { abortSignal },
    ) => {
      try {
        const subagent = new ToolLoopAgent({
          model,
          instructions: subagentInstructions(nutrition, avoidedTerms),
          maxOutputTokens: SUBAGENT_MAX_OUTPUT_TOKENS,
          tools: {
            webSearch: webSearchTool(),
            searchRecipes: searchRecipesTool(mealPlan, userId),
            searchKnowledge: searchKnowledgeTool(knowledge),
          },
          stopWhen: isStepCount(SUBAGENT_MAX_STEPS),
          prepareStep: ({ stepNumber }) =>
            stepNumber === SUBAGENT_MAX_STEPS - 1
              ? { toolChoice: 'none' }
              : {},
        });

        const contextParts = [question];
        if (externalFoods && externalFoods.length > 0) {
          contextParts.push(
            `Món ăn/thức uống bên ngoài cần tra cứu & ước tính: ${externalFoods.join(', ')}.`,
          );
        }
        if (remainingCaloriesBudget !== undefined) {
          contextParts.push(
            `Ngân sách năng lượng còn lại tham khảo: ~${remainingCaloriesBudget} kcal.`,
          );
        }

        const result = await subagent.generate({
          prompt: contextParts.join('\n'),
          abortSignal,
        });
        return {
          status: 'ok' as const,
          summary: result.text.trim(),
        };
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        logger.warn(`Nutrition subagent failed: ${String(error)}`);
        return {
          status: 'fallback' as const,
          summary:
            'Chưa tra cứu được dữ liệu web mở rộng ngay lúc này; Trợ lý chính có thể dùng ước tính tham khảo thông thường và điều chỉnh bằng kho công thức Vedora.',
        };
      }
    },
    toModelOutput: ({ output }) => ({
      type: 'text',
      value: output.summary,
    }),
  });
}
