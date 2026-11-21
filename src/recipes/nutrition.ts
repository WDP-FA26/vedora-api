import {
  ActivityLevel,
  BiologicalSex,
  BmiCategory,
  NutritionGoal,
  NutritionPillar,
  RecipeTag,
} from '../mongo/enums.js';

export interface NutritionProfileInput {
  heightCm: number | null;
  weightKg: number | null;
  targetWeightKg: number | null;
  birthYear: number | null;
  biologicalSex: BiologicalSex | null;
  activityLevel: ActivityLevel | null;
  nutritionGoal: NutritionGoal | null;
}

export function todayDateInZone(
  timeZone: string,
  now: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export interface ComputedNutritionMetrics {
  bmi: number | null;
  bmiCategory: BmiCategory | null;
  suggestedGoal: NutritionGoal | null;
  effectiveGoal: NutritionGoal | null;
  idealWeightMinKg: number | null;
  idealWeightMaxKg: number | null;
  bmr: number | null;
  tdee: number | null;
  dailyCalorieTarget: number | null;
  dailyCalorieMin: number | null;
  dailyCalorieMax: number | null;
  safetyNote: string | null;
}

const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  [ActivityLevel.SEDENTARY]: 1.2,
  [ActivityLevel.LIGHT]: 1.375,
  [ActivityLevel.MODERATE]: 1.55,
  [ActivityLevel.ACTIVE]: 1.725,
};

const DEFAULT_AGE = 30;
const MIN_SAFE_DAILY_KCAL = 1200;
const GOAL_DELTA_KCAL = 350;
const FLEXIBLE_TOLERANCE_RATIO = 0.15;

/** Asian WPRO/IDI BMI category cutoffs: <18.5, 18.5-22.9, 23.0-24.9, >=25.0. */
export function classifyAsianBmi(bmi: number): BmiCategory {
  if (bmi < 18.5) return BmiCategory.UNDERWEIGHT;
  if (bmi < 23.0) return BmiCategory.NORMAL;
  if (bmi < 25.0) return BmiCategory.OVERWEIGHT;
  return BmiCategory.OBESE;
}

export function suggestedGoalForBmi(bmi: number): NutritionGoal {
  const category = classifyAsianBmi(bmi);
  if (category === BmiCategory.UNDERWEIGHT) return NutritionGoal.GAIN_WEIGHT;
  if (category === BmiCategory.NORMAL) return NutritionGoal.MAINTAIN;
  return NutritionGoal.LOSE_WEIGHT;
}

export function calculateBmi(weightKg: number, heightCm: number): number {
  const meters = heightCm / 100;
  return Math.round((weightKg / (meters * meters)) * 10) / 10;
}

function roundToTen(value: number): number {
  return Math.round(value / 10) * 10;
}

function sexOffset(sex: BiologicalSex | null): number {
  if (sex === BiologicalSex.MALE) return 5;
  if (sex === BiologicalSex.FEMALE) return -161;
  return -78;
}

/**
 * Computes Asian BMI, healthy weight range for height, Mifflin-St Jeor TDEE,
 * and flexible (±15%) daily calorie target from a user's body profile.
 */
export function computeNutritionMetrics(
  input: NutritionProfileInput,
  currentYear: number = new Date().getFullYear(),
): ComputedNutritionMetrics {
  const { heightCm, weightKg } = input;
  if (
    heightCm === null ||
    weightKg === null ||
    heightCm <= 0 ||
    weightKg <= 0
  ) {
    return {
      bmi: null,
      bmiCategory: null,
      suggestedGoal: null,
      effectiveGoal: input.nutritionGoal,
      idealWeightMinKg: null,
      idealWeightMaxKg: null,
      bmr: null,
      tdee: null,
      dailyCalorieTarget: null,
      dailyCalorieMin: null,
      dailyCalorieMax: null,
      safetyNote: null,
    };
  }

  const bmi = calculateBmi(weightKg, heightCm);
  const bmiCategory = classifyAsianBmi(bmi);
  const suggestedGoal = suggestedGoalForBmi(bmi);
  const effectiveGoal = input.nutritionGoal ?? suggestedGoal;

  const meters = heightCm / 100;
  const idealWeightMinKg = Math.round(18.5 * meters * meters * 10) / 10;
  const idealWeightMaxKg = Math.round(22.9 * meters * meters * 10) / 10;

  const age =
    input.birthYear !== null
      ? Math.max(13, Math.min(100, currentYear - input.birthYear))
      : DEFAULT_AGE;
  const bmr = Math.round(
    10 * weightKg + 6.25 * heightCm - 5 * age + sexOffset(input.biologicalSex),
  );
  const multiplier =
    ACTIVITY_MULTIPLIER[input.activityLevel ?? ActivityLevel.LIGHT];
  const tdee = roundToTen(bmr * multiplier);

  let dailyCalorieTarget = tdee;
  let safetyNote: string | null = null;

  if (
    bmiCategory === BmiCategory.UNDERWEIGHT &&
    effectiveGoal === NutritionGoal.LOSE_WEIGHT
  ) {
    dailyCalorieTarget = tdee;
    safetyNote =
      'BMI của bạn đang ở mức cần bồi bổ (< 18,5), hệ thống giữ mức năng lượng duy trì an toàn thay vì cắt giảm thêm.';
  } else if (effectiveGoal === NutritionGoal.LOSE_WEIGHT) {
    dailyCalorieTarget = Math.max(
      MIN_SAFE_DAILY_KCAL,
      roundToTen(tdee - GOAL_DELTA_KCAL),
    );
  } else if (effectiveGoal === NutritionGoal.GAIN_WEIGHT) {
    dailyCalorieTarget = roundToTen(tdee + GOAL_DELTA_KCAL);
  }

  const dailyCalorieMin = roundToTen(
    dailyCalorieTarget * (1 - FLEXIBLE_TOLERANCE_RATIO),
  );
  const dailyCalorieMax = roundToTen(
    dailyCalorieTarget * (1 + FLEXIBLE_TOLERANCE_RATIO),
  );

  return {
    bmi,
    bmiCategory,
    suggestedGoal,
    effectiveGoal,
    idealWeightMinKg,
    idealWeightMaxKg,
    bmr,
    tdee,
    dailyCalorieTarget,
    dailyCalorieMin,
    dailyCalorieMax,
    safetyNote,
  };
}

const PROTEIN_KEYWORDS = [
  'đậu hũ',
  'tàu hũ',
  'đậu phụ',
  'đậu nành',
  'tempeh',
  'seitan',
  'mì căn',
  'đậu xanh',
  'đậu đỏ',
  'đậu đen',
  'đậu lăng',
  'đậu gà',
  'đậu hà lan',
  'đậu phộng',
  'bơ đậu phộng',
  'sữa đậu nành',
  'tương hột',
  'chao',
  'nấm',
  'trứng',
  'phô mai',
  'sữa bò',
  'hạt bí',
  'hạt điều',
  'hạnh nhân',
  'óc chó',
  'yến mạch',
];

const FIBER_KEYWORDS = [
  'rau',
  'cải',
  'xà lách',
  'mồng tơi',
  'bông cải',
  'súp lơ',
  'cần tây',
  'giá đỗ',
  'ngó sen',
  'cà chua',
  'cà rốt',
  'bí đao',
  'bí đỏ',
  'khổ qua',
  'đậu bắp',
  'cà tím',
  'dưa leo',
  'mướp',
  'củ cải',
  'củ dền',
  'su su',
  'củ đậu',
  'bắp cải',
  'nấm',
  'khoai lang',
  'khoai môn',
  'khoai tây',
  'đậu que',
  'ớt chuông',
  'bắp ngô',
  'dứa',
  'chuối',
  'cam',
  'bơ',
  'mít non',
  'măng',
];

const HEALTHY_FAT_KEYWORDS = [
  'bơ đậu phộng',
  'đậu phộng',
  'hạnh nhân',
  'óc chó',
  'hạt mè',
  'mè đen',
  'dầu mè',
  'hạt bí',
  'hạt chia',
  'hạt lanh',
  'hạt hướng dương',
  'nước cốt dừa',
  'dầu ô liu',
  'quả bơ',
];

const IRON_KEYWORDS = [
  'đậu lăng',
  'đậu đen',
  'đậu đỏ',
  'đậu gà',
  'mè đen',
  'rau bina',
  'cải bó xôi',
  'rau chân vịt',
  'nấm mèo',
  'hạt bí',
  'tempeh',
  'rau dền',
  'đậu nành',
  'đậu hũ',
  'tàu hũ',
  'yến mạch',
  'hạt sen',
];

const CALCIUM_KEYWORDS = [
  'đậu hũ',
  'tàu hũ',
  'mè đen',
  'hạt mè',
  'cải thìa',
  'cải chíp',
  'cải ngọt',
  'bông cải xanh',
  'súp lơ xanh',
  'rau dền',
  'rau muống',
  'đậu bắp',
  'sữa đậu nành',
  'sữa hạnh nhân',
  'sữa yến mạch',
  'sữa bò',
  'phô mai',
  'sữa chua',
  'hạnh nhân',
  'đậu gà',
];

function containsAny(text: string, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => text.includes(keyword));
}

function isHealthyFatIngredient(normalizedName: string): boolean {
  if (normalizedName === 'bơ') return true;
  if (normalizedName.includes('hạt điều') && !normalizedName.includes('màu')) {
    return true;
  }
  return containsAny(normalizedName, HEALTHY_FAT_KEYWORDS);
}

function isProteinIngredient(normalizedName: string): boolean {
  if (normalizedName.includes('hạt điều màu')) return false;
  return containsAny(normalizedName, PROTEIN_KEYWORDS);
}

/**
 * Infers plant-based nutrition pillars from ingredient names and merges with
 * any explicit pillars saved on the recipe.
 */
export function inferNutritionPillars(
  ingredientNames: readonly string[],
  explicit: readonly NutritionPillar[] = [],
): NutritionPillar[] {
  const found = new Set<NutritionPillar>(explicit);
  for (const raw of ingredientNames) {
    const name = raw.normalize('NFC').trim().toLowerCase();
    if (!name) continue;
    if (isProteinIngredient(name)) found.add(NutritionPillar.PLANT_PROTEIN);
    if (containsAny(name, FIBER_KEYWORDS)) found.add(NutritionPillar.FIBER_VEG);
    if (isHealthyFatIngredient(name)) found.add(NutritionPillar.HEALTHY_FAT);
    if (containsAny(name, IRON_KEYWORDS)) found.add(NutritionPillar.IRON_RICH);
    if (containsAny(name, CALCIUM_KEYWORDS)) {
      found.add(NutritionPillar.CALCIUM_RICH);
    }
  }
  return Object.values(NutritionPillar).filter((pillar) => found.has(pillar));
}

const BASE_KCAL_BY_TAG: Record<RecipeTag, number> = {
  [RecipeTag.RICE]: 420,
  [RecipeTag.NOODLES]: 400,
  [RecipeTag.BREAD]: 350,
  [RecipeTag.STIR_FRY]: 260,
  [RecipeTag.SNACK]: 260,
  [RecipeTag.DESSERT]: 240,
  [RecipeTag.SOUP]: 170,
  [RecipeTag.SALAD]: 180,
  [RecipeTag.DRINK]: 160,
};

/**
 * Returns the stored `caloriesPerServing` or estimates an approximate value
 * per serving from the recipe tag, title, and ingredients so tracking never breaks.
 */
export function resolveCaloriesPerServing(input: {
  caloriesPerServing?: number | null;
  tag: RecipeTag | null;
  title: string;
  ingredientNames: readonly string[];
}): number {
  if (
    typeof input.caloriesPerServing === 'number' &&
    Number.isFinite(input.caloriesPerServing) &&
    input.caloriesPerServing > 0
  ) {
    return Math.round(input.caloriesPerServing);
  }
  let kcal = input.tag ? BASE_KCAL_BY_TAG[input.tag] : 280;
  const joined = [input.title, ...input.ingredientNames]
    .join(' ')
    .normalize('NFC')
    .toLowerCase();
  if (joined.includes('chiên') || joined.includes('nước cốt dừa')) kcal += 70;
  if (joined.includes('đậu hũ') || joined.includes('tàu hũ')) kcal += 30;
  if (
    joined.includes('bơ đậu phộng') ||
    (joined.includes('đậu phộng') && input.tag === RecipeTag.SALAD)
  ) {
    kcal += 50;
  }
  return Math.max(80, Math.min(900, Math.round(kcal / 10) * 10));
}

const ALLERGEN_FAMILIES: readonly {
  triggers: readonly string[];
  matches: readonly string[];
}[] = [
  {
    triggers: ['đậu phộng', 'củ lạc', 'hạt lạc', 'peanut'],
    matches: ['đậu phộng', 'bơ đậu phộng'],
  },
  {
    triggers: ['dị ứng hạt', 'kiêng hạt', 'các loại hạt', 'tree nut'],
    matches: [
      'hạt điều',
      'hạnh nhân',
      'óc chó',
      'hạt dẻ',
      'hạt mè',
      'đậu phộng',
    ],
  },
  {
    triggers: ['hạt điều'],
    matches: ['hạt điều'],
  },
  {
    triggers: ['mè', 'vừng', 'sesame'],
    matches: ['hạt mè', 'mè đen', 'mè trắng', 'dầu mè', 'muối mè'],
  },
  {
    triggers: ['đậu nành', 'đậu tương', 'soy', 'đạm đậu nành'],
    matches: [
      'đậu nành',
      'đậu hũ',
      'đậu phụ',
      'tàu hũ',
      'tương hột',
      'nước tương',
    ],
  },
  {
    triggers: ['gluten', 'lúa mì', 'bột mì', 'mì căn'],
    matches: ['bánh mì', 'bột mì', 'mì căn', 'hoành thánh'],
  },
  {
    triggers: ['dị ứng nấm', 'kiêng nấm', 'không ăn nấm'],
    matches: ['nấm', 'bột nêm nấm'],
  },
  {
    triggers: ['ngũ vị tân', 'dị ứng hành', 'kiêng hành', 'hành tỏi'],
    matches: ['hành', 'tỏi', 'hẹ', 'kiệu'],
  },
  {
    triggers: ['ăn cay', 'bị cay', 'kiêng cay', 'dị ứng ớt', 'không ăn ớt'],
    matches: ['ớt', 'sa tế'],
  },
  {
    triggers: ['nước cốt dừa', 'cốt dừa', 'dị ứng dừa'],
    matches: ['nước cốt dừa', 'cốt dừa'],
  },
  {
    triggers: ['yến mạch'],
    matches: ['yến mạch', 'sữa yến mạch'],
  },
];

const DIRECT_INGREDIENT_HINTS = [
  'khổ qua',
  'mướp đắng',
  'cà tím',
  'khoai môn',
  'đậu bắp',
  'nấm rơm',
  'nấm hương',
  'nấm đùi gà',
  'nấm mèo',
  'nấm bào ngư',
  'đậu xanh',
  'đậu đỏ',
  'đậu đen',
  'hạt sen',
  'rau bina',
  'rau muống',
  'hành tây',
  'hành tím',
  'hành lá',
  'tỏi',
  'gừng',
  'sả',
  'cần tây',
  'giá đỗ',
  'ngó sen',
  'bông cải',
  'cà chua',
  'chuối',
  'cà phê',
  'trà xanh',
  'ớt',
  'sa tế',
];

/**
 * Extracts normalized allergen/avoidance keywords from free-text Vietnamese
 * dietary notes, expanding common allergen families (soy, gluten, nuts, sesame, etc.).
 */
export function extractAllergyKeywords(
  allergyNote: string | null | undefined,
): string[] {
  if (!allergyNote) return [];
  const normalized = allergyNote.normalize('NFC').trim().toLowerCase();
  if (!normalized) return [];

  const found = new Set<string>();
  for (const family of ALLERGEN_FAMILIES) {
    if (family.triggers.some((trigger) => normalized.includes(trigger))) {
      for (const term of family.matches) found.add(term);
    }
  }
  for (const hint of DIRECT_INGREDIENT_HINTS) {
    if (normalized.includes(hint)) found.add(hint);
  }
  return [...found];
}
