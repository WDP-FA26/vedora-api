import { Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { runtimeConfig } from '../config/runtime-config.js';
import {
  BodyMetricLog,
  Ingredient,
  IngredientGroup,
  NutritionGoal,
  User,
} from '../mongo/models.js';
import {
  DietaryMemoryDto,
  MAX_MEMORY_ITEM_LENGTH,
  MAX_MEMORY_ITEMS,
  NutritionProfileDto,
  SaveDietaryMemoryDto,
  SaveNutritionProfileDto,
  WeightCheckInDto,
} from './dto/dietary.dto.js';
import {
  calculateBmi,
  computeNutritionMetrics,
  todayDateInZone,
} from './nutrition.js';
import { InvalidInputException } from '../common/exceptions/invalid-input.exception.js';

const MAX_METRIC_HISTORY = 90;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString().slice(0, 10) === value;
}

export type MemorySection = keyof DietaryMemoryDto;

@Injectable()
export class DietaryService {
  constructor(
    @InjectModel(Ingredient.name)
    private readonly ingredients: Model<Ingredient>,
    @InjectModel(IngredientGroup.name)
    private readonly groups: Model<IngredientGroup>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @Optional()
    @InjectModel(BodyMetricLog.name)
    private readonly metricLogs?: Model<BodyMetricLog>,
  ) {}

  async find(userId: string): Promise<DietaryMemoryDto> {
    const user = await this.users
      .findOne({ _id: userId })
      .select(['allergies', 'foodPreferences', ...LEGACY_FIELDS])
      .lean<LegacyDietaryFields>()
      .exec();
    if (!user) return { allergies: [], preferences: [] };
    if (LEGACY_FIELDS.some((key) => user[key] !== undefined)) {
      return this.migrateLegacy(user);
    }
    return {
      allergies: user.allergies ?? [],
      preferences: user.foodPreferences ?? [],
    };
  }

  async replace(
    userId: string,
    dto: SaveDietaryMemoryDto,
  ): Promise<DietaryMemoryDto> {
    await this.find(userId);
    const updateSet: Record<string, string[]> = {};
    if (dto.allergies !== undefined) updateSet.allergies = dto.allergies;
    if (dto.preferences !== undefined) {
      updateSet.foodPreferences = dto.preferences;
    }
    if (Object.keys(updateSet).length > 0) {
      await this.users.updateOne({ _id: userId }, { $set: updateSet }).exec();
    }
    return this.find(userId);
  }

  async updateMemory(
    userId: string,
    section: MemorySection,
    change: { add?: readonly string[]; remove?: readonly string[] },
  ): Promise<string[]> {
    const current = await this.find(userId);
    const removed = new Set((change.remove ?? []).map((line) => line.trim()));
    const lines = current[section].filter((line) => !removed.has(line));
    for (const raw of change.add ?? []) {
      const line = raw.trim().slice(0, MAX_MEMORY_ITEM_LENGTH);
      if (line !== '' && !lines.includes(line)) lines.push(line);
    }
    if (lines.length > MAX_MEMORY_ITEMS) {
      throw new InvalidInputException(
        'DIETARY_MEMORY_FULL',
        `A memory section holds at most ${MAX_MEMORY_ITEMS} lines`,
      );
    }
    const field = section === 'allergies' ? 'allergies' : 'foodPreferences';
    await this.users
      .updateOne({ _id: userId }, { $set: { [field]: lines } })
      .exec();
    return lines;
  }

  async findNutrition(userId: string): Promise<NutritionProfileDto> {
    const [user, logs] = await Promise.all([
      this.users
        .findOne({ _id: userId })
        .select([...NUTRITION_FIELDS])
        .lean<UserNutritionFields>()
        .exec(),
      this.recentMetricLogs(userId),
    ]);
    return buildNutritionProfile(user, logs);
  }

  async findPlannerContext(userId: string): Promise<{
    memory: DietaryMemoryDto;
    nutrition: NutritionProfileDto;
  }> {
    const [user, logs] = await Promise.all([
      this.users
        .findOne({ _id: userId })
        .select([
          'allergies',
          'foodPreferences',
          ...LEGACY_FIELDS,
          ...NUTRITION_FIELDS,
        ])
        .lean<LegacyDietaryFields & UserNutritionFields>()
        .exec(),
      this.recentMetricLogs(userId),
    ]);
    let memory: DietaryMemoryDto;
    if (!user) {
      memory = { allergies: [], preferences: [] };
    } else if (LEGACY_FIELDS.some((key) => user[key] !== undefined)) {
      memory = await this.migrateLegacy(user);
    } else {
      memory = {
        allergies: user.allergies ?? [],
        preferences: user.foodPreferences ?? [],
      };
    }
    return {
      memory,
      nutrition: buildNutritionProfile(user, logs),
    };
  }

  private recentMetricLogs(userId: string): Promise<BodyMetricLog[]> {
    if (!this.metricLogs) return Promise.resolve([]);
    return this.metricLogs
      .find({ userId })
      .sort({ date: -1 })
      .limit(MAX_METRIC_HISTORY)
      .exec();
  }

  async saveNutrition(
    userId: string,
    dto: SaveNutritionProfileDto,
  ): Promise<NutritionProfileDto> {
    const current = await this.users
      .findOne({ _id: userId })
      .select(
        'heightCm weightKg targetWeightKg birthYear biologicalSex activityLevel nutritionGoal',
      )
      .exec();

    const heightCm =
      dto.heightCm !== undefined ? dto.heightCm : (current?.heightCm ?? null);
    const weightKg =
      dto.weightKg !== undefined ? dto.weightKg : (current?.weightKg ?? null);
    const targetWeightKg =
      dto.targetWeightKg !== undefined
        ? dto.targetWeightKg
        : (current?.targetWeightKg ?? null);
    const birthYear =
      dto.birthYear !== undefined
        ? dto.birthYear
        : (current?.birthYear ?? null);
    const biologicalSex =
      dto.biologicalSex !== undefined
        ? dto.biologicalSex
        : (current?.biologicalSex ?? null);
    const activityLevel =
      dto.activityLevel !== undefined
        ? dto.activityLevel
        : (current?.activityLevel ?? null);
    const nutritionGoal =
      dto.nutritionGoal !== undefined
        ? dto.nutritionGoal
        : (current?.nutritionGoal ?? null);

    const today = todayDateInZone(runtimeConfig.APP_TIMEZONE);
    const currentYear = Number(today.slice(0, 4));
    if (birthYear !== null && birthYear > currentYear - 13) {
      throw new InvalidInputException(
        'INVALID_BIRTH_YEAR',
        'Tính năng theo dõi dinh dưỡng chỉ hỗ trợ từ 13 tuổi trở lên.',
      );
    }

    if (
      heightCm !== null &&
      targetWeightKg !== null &&
      calculateBmi(targetWeightKg, heightCm) < 18.5 &&
      nutritionGoal === NutritionGoal.LOSE_WEIGHT
    ) {
      throw new InvalidInputException(
        'UNSAFE_TARGET_WEIGHT',
        'Cân nặng mục tiêu thấp hơn ngưỡng BMI lành mạnh (< 18,5). Bạn hãy chọn mức cân nặng an toàn hơn nhé.',
      );
    }

    await this.users
      .findOneAndUpdate(
        { _id: userId },
        {
          $set: {
            heightCm,
            weightKg,
            targetWeightKg,
            birthYear,
            biologicalSex,
            activityLevel,
            nutritionGoal,
          },
        },
        { returnDocument: 'after' },
      )
      .exec();

    const shouldRecordLog =
      this.metricLogs !== undefined &&
      heightCm !== null &&
      weightKg !== null &&
      (dto.weightKg !== undefined ||
        dto.heightCm !== undefined ||
        dto.feeling !== undefined ||
        dto.note !== undefined);

    if (shouldRecordLog && this.metricLogs) {
      const logSet: Record<string, unknown> = {
        weightKg,
        heightCm,
        bmi: calculateBmi(weightKg, heightCm),
      };
      if (dto.feeling !== undefined) logSet.feeling = dto.feeling;
      if (dto.note !== undefined) logSet.note = dto.note || null;
      await this.metricLogs
        .findOneAndUpdate(
          { userId, date: today },
          {
            $set: logSet,
            $setOnInsert: { _id: randomUUID(), userId, date: today },
          },
          { upsert: true, returnDocument: 'after' },
        )
        .exec();
    }

    return this.findNutrition(userId);
  }

  async checkInWeight(
    userId: string,
    dto: WeightCheckInDto,
  ): Promise<NutritionProfileDto> {
    const user = await this.users
      .findOne({ _id: userId })
      .select('heightCm weightKg')
      .exec();
    const heightCm = dto.heightCm ?? user?.heightCm ?? null;
    if (heightCm === null) {
      throw new InvalidInputException(
        'HEIGHT_REQUIRED',
        'Hãy nhập chiều cao trước khi ghi nhận cân nặng.',
      );
    }

    const today = todayDateInZone(runtimeConfig.APP_TIMEZONE);
    const date = dto.date ?? today;
    if (!isRealDate(date) || date > today) {
      throw new InvalidInputException(
        'INVALID_DATE',
        'Ngày ghi nhận không hợp lệ hoặc nằm trong tương lai.',
      );
    }

    const bmi = calculateBmi(dto.weightKg, heightCm);
    if (this.metricLogs) {
      const logSet: Record<string, unknown> = {
        weightKg: dto.weightKg,
        heightCm,
        bmi,
      };
      if (dto.feeling !== undefined) logSet.feeling = dto.feeling;
      if (dto.note !== undefined) logSet.note = dto.note || null;

      await this.metricLogs
        .findOneAndUpdate(
          { userId, date },
          {
            $set: logSet,
            $setOnInsert: { _id: randomUUID(), userId, date },
          },
          { upsert: true, returnDocument: 'after' },
        )
        .exec();
    }

    const latest = this.metricLogs
      ? await this.metricLogs
          .findOne({ userId })
          .sort({ date: -1 })
          .select('date')
          .exec()
      : null;

    if (!latest || date >= latest.date) {
      const userSet: Record<string, unknown> = { weightKg: dto.weightKg };
      if (dto.heightCm !== undefined) userSet.heightCm = dto.heightCm;
      await this.users
        .findOneAndUpdate({ _id: userId }, { $set: userSet })
        .exec();
    }

    return this.findNutrition(userId);
  }

  private async migrateLegacy(
    user: LegacyDietaryFields,
  ): Promise<DietaryMemoryDto> {
    const avoidedNames = await this.avoidedNames(
      user.avoidedIngredientIds ?? [],
      user.avoidedGroupIds ?? [],
    );
    const allergyLines = [
      ...(user.allergies ?? []),
      ...noteLines(user.allergyNote),
    ];
    if (avoidedNames.length > 0) {
      allergyLines.push(`Không ăn: ${avoidedNames.join(', ')}`);
    }
    const memory: DietaryMemoryDto = {
      allergies: uniqueLines(allergyLines),
      preferences: uniqueLines([
        ...(user.foodPreferences ?? []),
        ...noteLines(user.preferenceNote),
      ]),
    };
    const unset: Record<string, ''> = {};
    for (const key of LEGACY_FIELDS) unset[key] = '';
    await this.users
      .updateOne(
        { _id: user._id },
        {
          $set: {
            allergies: memory.allergies,
            foodPreferences: memory.preferences,
          },
          $unset: unset,
        },
        { strict: false },
      )
      .exec();
    return memory;
  }

  private async avoidedNames(
    ingredientIds: readonly string[],
    groupIds: readonly string[],
  ): Promise<string[]> {
    if (ingredientIds.length === 0 && groupIds.length === 0) return [];
    const [ingredients, groups] = await Promise.all([
      this.ingredients
        .find({ _id: { $in: [...ingredientIds] } })
        .select('name')
        .exec(),
      this.groups
        .find({ _id: { $in: [...groupIds] } })
        .select('name')
        .exec(),
    ]);
    const names = [
      ...groups.map(({ name }) => `nhóm ${name}`),
      ...ingredients.map(({ name }) => name),
    ];
    return names.sort();
  }
}

const NUTRITION_FIELDS = [
  'heightCm',
  'weightKg',
  'targetWeightKg',
  'birthYear',
  'biologicalSex',
  'activityLevel',
  'nutritionGoal',
] as const;

interface UserNutritionFields {
  heightCm?: number | null;
  weightKg?: number | null;
  targetWeightKg?: number | null;
  birthYear?: number | null;
  biologicalSex?: User['biologicalSex'];
  activityLevel?: User['activityLevel'];
  nutritionGoal?: User['nutritionGoal'];
}

function buildNutritionProfile(
  user: UserNutritionFields | null | undefined,
  logs: readonly BodyMetricLog[],
): NutritionProfileDto {
  const profile = {
    heightCm: user?.heightCm ?? null,
    weightKg: user?.weightKg ?? null,
    targetWeightKg: user?.targetWeightKg ?? null,
    birthYear: user?.birthYear ?? null,
    biologicalSex: user?.biologicalSex ?? null,
    activityLevel: user?.activityLevel ?? null,
    nutritionGoal: user?.nutritionGoal ?? null,
  };
  const today = todayDateInZone(runtimeConfig.APP_TIMEZONE);
  const currentYear = Number(today.slice(0, 4));
  const metrics = computeNutritionMetrics(profile, currentYear);

  const history = [...logs].reverse().map((log) => ({
    id: log.id,
    date: log.date,
    weightKg: log.weightKg,
    heightCm: log.heightCm,
    bmi: log.bmi,
    feeling: log.feeling ?? null,
    note: log.note ?? null,
    updatedAt: log.updatedAt,
  }));

  return {
    ...profile,
    ...metrics,
    history,
  };
}

const LEGACY_FIELDS = [
  'allergyNote',
  'preferenceNote',
  'avoidedIngredientIds',
  'avoidedGroupIds',
] as const;

interface LegacyDietaryFields {
  _id: string;
  allergies?: string[];
  foodPreferences?: string[];
  allergyNote?: string | null;
  preferenceNote?: string | null;
  avoidedIngredientIds?: string[];
  avoidedGroupIds?: string[];
}

function noteLines(note: string | null | undefined): string[] {
  if (!note) return [];
  const lines: string[] = [];
  for (const raw of note.split('\n')) {
    const line = raw.replace(/^\s*[-*•]\s*/, '').trim();
    if (line !== '') lines.push(line.slice(0, MAX_MEMORY_ITEM_LENGTH));
  }
  return lines;
}

function uniqueLines(lines: readonly string[]): string[] {
  return [...new Set(lines)].slice(0, MAX_MEMORY_ITEMS);
}
