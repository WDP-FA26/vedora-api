import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectModel as InjectLanguageModel } from '@nestjs/ai';
import { InjectModel } from '@nestjs/mongoose';
import { generateText, type LanguageModel, Output } from 'ai';
import type { Model } from 'mongoose';
import { z } from 'zod';
import { PromptCache } from '../ai/prompt-cache.js';
import { AllergyVerdict, Ingredient, Recipe } from '../mongo/models.js';
import {
  ALLERGY_AUDIT_INSTRUCTIONS,
  type AuditedRecipe,
  buildAllergyAuditPrompt,
} from './allergy-audit.prompt.js';
import { DietaryService } from './dietary.service.js';

const BATCH_SIZE = 20;
const PARALLEL_BATCHES = 4;

export const UNCHECKED_ALLERGY_WARNING =
  'Chưa kiểm tra được món này với hồ sơ dị ứng, nên tạm chưa xếp vào thực đơn.';

const allergyAuditSchema = z.object({
  flagged: z
    .array(
      z.object({
        recipeId: z.string(),
        reason: z
          .string()
          .describe(
            'Lý do ngắn gọn bằng tiếng Việt món này vi phạm dị ứng/lưu ý',
          ),
      }),
    )
    .describe(
      'Only recipes that genuinely contain or risk triggering an allergen or restriction',
    ),
  summary: z
    .string()
    .describe('Tóm tắt kết quả kiểm định ngắn gọn bằng tiếng Việt'),
});

export interface AllergyCheck {
  unsafe: Map<string, string>;
  unchecked: Set<string>;
}

export function allergyWarningOf(
  check: AllergyCheck,
  recipeId: string,
): string | null {
  const reason = check.unsafe.get(recipeId);
  if (reason !== undefined) return reason;
  if (check.unchecked.has(recipeId)) return UNCHECKED_ALLERGY_WARNING;
  return null;
}

export function isAllergySafe(check: AllergyCheck, recipeId: string): boolean {
  return !check.unsafe.has(recipeId) && !check.unchecked.has(recipeId);
}

interface PendingRecipe {
  recipe: AuditedRecipe;
  version: string;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

@Injectable()
export class AllergyAuditService {
  private readonly logger = new Logger(AllergyAuditService.name);

  constructor(
    @InjectLanguageModel() private readonly model: LanguageModel,
    @InjectModel(AllergyVerdict.name)
    private readonly verdicts: Model<AllergyVerdict>,
    @InjectModel(Recipe.name) private readonly recipes: Model<Recipe>,
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    private readonly dietary: DietaryService,
  ) {}

  async check(
    userId: string,
    recipeIds: readonly string[],
  ): Promise<AllergyCheck> {
    const result: AllergyCheck = { unsafe: new Map(), unchecked: new Set() };
    const ids = [...new Set(recipeIds)];
    if (ids.length === 0) return result;
    const { allergies } = await this.dietary.find(userId);
    const notes = allergies
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .join(' | ');
    if (notes === '') return result;

    const profileHash = digest([ALLERGY_AUDIT_INSTRUCTIONS, notes]);
    const [audited, stored] = await Promise.all([
      this.auditedRecipes(ids),
      this.verdicts.find({ userId, recipeId: { $in: ids } }).exec(),
    ]);
    const storedByRecipe = new Map(
      stored.map((verdict) => [verdict.recipeId, verdict]),
    );
    const pending: PendingRecipe[] = [];
    for (const item of audited) {
      const verdict = storedByRecipe.get(item.recipe.id);
      const isCurrent =
        verdict !== undefined &&
        verdict.profileHash === profileHash &&
        verdict.recipeVersion === item.version;
      if (!isCurrent) {
        pending.push(item);
        continue;
      }
      if (verdict.reason !== null) {
        result.unsafe.set(item.recipe.id, verdict.reason);
      }
    }

    const waveSize = BATCH_SIZE * PARALLEL_BATCHES;
    for (let start = 0; start < pending.length; start += waveSize) {
      const wave = pending.slice(start, start + waveSize);
      const batches: PendingRecipe[][] = [];
      for (let offset = 0; offset < wave.length; offset += BATCH_SIZE) {
        batches.push(wave.slice(offset, offset + BATCH_SIZE));
      }
      await Promise.all(
        batches.map((batch) =>
          this.auditBatch(userId, notes, profileHash, batch, result),
        ),
      );
    }
    return result;
  }

  private async auditBatch(
    userId: string,
    notes: string,
    profileHash: string,
    batch: PendingRecipe[],
    result: AllergyCheck,
  ): Promise<void> {
    let flagged: { recipeId: string; reason: string }[];
    try {
      const { output } = await generateText({
        model: this.model,
        output: Output.object({ schema: allergyAuditSchema }),
        ...PromptCache.singleTurn({
          session: 'vedora-allergy-verifier',
          instructions: ALLERGY_AUDIT_INSTRUCTIONS,
          effort: 'medium',
          ttl: '5m',
        }),
        prompt: buildAllergyAuditPrompt({
          allergyNotes: notes,
          recipes: batch.map(({ recipe }) => recipe),
        }),
      });
      flagged = output.flagged;
    } catch (error) {
      this.logger.warn(`Allergy audit failed: ${String(error)}`);
      for (const { recipe } of batch) result.unchecked.add(recipe.id);
      return;
    }

    const reasons = new Map<string, string>();
    for (const item of flagged) {
      reasons.set(
        item.recipeId,
        item.reason.trim() || 'Không hợp hồ sơ dị ứng.',
      );
    }
    for (const { recipe } of batch) {
      const reason = reasons.get(recipe.id);
      if (reason !== undefined) result.unsafe.set(recipe.id, reason);
    }
    await this.verdicts
      .bulkWrite(
        batch.map(({ recipe, version }) => ({
          updateOne: {
            filter: { userId, recipeId: recipe.id },
            update: {
              $set: {
                profileHash,
                recipeVersion: version,
                reason: reasons.get(recipe.id) ?? null,
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      )
      .catch((error: unknown) => {
        this.logger.warn(`Allergy verdicts were not saved: ${String(error)}`);
      });
  }

  private async auditedRecipes(ids: string[]): Promise<PendingRecipe[]> {
    const rows = await this.recipes
      .find({ _id: { $in: ids } })
      .select('title ingredients steps')
      .exec();
    const ingredientIds = new Set<string>();
    for (const row of rows) {
      for (const item of row.ingredients) ingredientIds.add(item.ingredientId);
    }
    const names = await this.ingredients
      .find({ _id: { $in: [...ingredientIds] } })
      .select('name')
      .exec();
    const nameById = new Map(names.map((item) => [item.id, item.name]));

    const audited: PendingRecipe[] = [];
    for (const row of rows) {
      const ingredients: { name: string; note: string | null }[] = [];
      for (const item of row.ingredients) {
        const name = nameById.get(item.ingredientId);
        if (name) ingredients.push({ name, note: item.note ?? null });
      }
      const recipe: AuditedRecipe = {
        id: row.id,
        title: row.title,
        ingredients,
        steps: [...row.steps],
      };
      audited.push({
        recipe,
        version: digest([recipe.title, recipe.ingredients, recipe.steps]),
      });
    }
    return audited;
  }
}
