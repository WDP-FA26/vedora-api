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
import { allExist } from '../mongo/references.js';
import {
  DietaryOptionsDto,
  DietaryRestrictionsDto,
  NutritionProfileDto,
  SaveDietaryRestrictionsDto,
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

  async options(): Promise<DietaryOptionsDto> {
    const [ingredients, groups] = await Promise.all([
      this.ingredients.find().sort({ name: 1 }).exec(),
      this.groups.find({ dietary: true }).sort({ name: 1 }).exec(),
    ]);
    const nameOf = new Map(ingredients.map(({ id, name }) => [id, name]));
    return {
      ingredients: ingredients.map(({ id, name, aliases }) => ({
        id,
        name,
        aliases: [...aliases],
      })),
      groups: groups.map(({ id, name, ingredientIds }) => ({
        id,
        name,
        ingredients: ingredientIds
          .map((ingredientId) => nameOf.get(ingredientId) ?? '')
          .sort(),
      })),
    };
  }

  async find(userId: string): Promise<DietaryRestrictionsDto> {
    const user = await this.preferences(userId);
    const [ingredients, groups] = await Promise.all([
      this.ingredients
        .find({
          _id: {
            $in: [...user.avoidedIngredientIds, ...user.likedIngredientIds],
          },
        })
        .select('name')
        .sort({ name: 1 })
        .exec(),
      this.groups
        .find({ _id: { $in: [...user.avoidedGroupIds] } })
        .select('name')
        .sort({ name: 1 })
        .exec(),
    ]);
    const liked = new Set(user.likedIngredientIds);
    return {
      ingredients: ingredients
        .filter(({ id }) => !liked.has(id))
        .map(({ id, name }) => ({ id, name })),
      groups: groups.map(({ id, name }) => ({ id, name })),
      liked: ingredients
        .filter(({ id }) => liked.has(id))
        .map(({ id, name }) => ({ id, name })),
      ...(user.allergyNote ? { allergyNote: user.allergyNote } : {}),
    };
  }

  async avoidedIngredientIds(userId: string): Promise<Set<string>> {
    const user = await this.preferences(userId);
    const viaGroups = await this.groups
      .find({ _id: { $in: [...user.avoidedGroupIds] } })
      .select('ingredientIds')
      .exec();
    return new Set([
      ...user.avoidedIngredientIds,
      ...viaGroups.flatMap(({ ingredientIds }) => ingredientIds),
    ]);
  }

  async replace(
    userId: string,
    dto: SaveDietaryRestrictionsDto,
  ): Promise<DietaryRestrictionsDto> {
    const avoided = new Set(dto.ingredientIds);
    if (dto.likedIngredientIds.some((id) => avoided.has(id))) {
      throw new InvalidInputException(
        'CONFLICTING_PREFERENCE',
        'An ingredient cannot be both liked and avoided',
      );
    }
    const [ingredients, groups] = await Promise.all([
      allExist(this.ingredients, [
        ...dto.ingredientIds,
        ...dto.likedIngredientIds,
      ]),
      allExist(this.groups, dto.groupIds),
    ]);
    if (!ingredients || !groups) {
      throw new InvalidInputException(
        'UNKNOWN_REFERENCE',
        'An ingredient or group in the request does not exist',
      );
    }
    const updateSet: Record<string, unknown> = {
      avoidedIngredientIds: dto.ingredientIds,
      avoidedGroupIds: dto.groupIds,
      likedIngredientIds: dto.likedIngredientIds,
    };
    if (dto.allergyNote !== undefined) {
      const normalizedNote = dto.allergyNote?.trim() ?? null;
      updateSet.allergyNote = normalizedNote || null;
    }
    await this.users
      .findOneAndUpdate(
        { _id: userId },
        { $set: updateSet },
        { returnDocument: 'after' },
      )
      .exec();
    return this.find(userId);
  }

  async findNutrition(userId: string): Promise<NutritionProfileDto> {
    const [user, logs] = await Promise.all([
      this.users
        .findOne({ _id: userId })
        .select(
          'heightCm weightKg targetWeightKg birthYear biologicalSex activityLevel nutritionGoal',
        )
        .exec(),
      this.metricLogs
        ? this.metricLogs
            .find({ userId })
            .sort({ date: -1 })
            .limit(MAX_METRIC_HISTORY)
            .exec()
        : Promise.resolve([]),
    ]);

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

  private async preferences(userId: string) {
    const user = await this.users
      .findOne({ _id: userId })
      .select(
        'avoidedIngredientIds avoidedGroupIds likedIngredientIds allergyNote',
      )
      .exec();
    return (
      user ?? {
        avoidedIngredientIds: [],
        avoidedGroupIds: [],
        likedIngredientIds: [],
        allergyNote: null,
      }
    );
  }
}
