import type { UIMessageChunk } from 'ai';
import type { MealSection, Weekday } from '../../mongo/models.js';
import type {
  BodyMetricsTab,
  RecipeSection,
  ScreenScrollDirection,
} from '../dto/meal-plan-voice.dto.js';
import { DAY_NAMES, SECTION_NAMES } from '../meal-planner.prompt.js';
import type {
  BodyMetricsSummary,
  SetScreenOutput,
} from '../tools/voice-screen.tools.js';

export type VoiceFocus =
  | {
      kind: 'recipe';
      recipeId: string;
      title: string;
      section: RecipeSection | null;
      step?: number | null;
    }
  | { kind: 'eatingLog'; date: string | null }
  | {
      kind: 'bodyMetrics';
      tab?: BodyMetricsTab | null;
      weekStart?: string | null;
    }
  | {
      kind: 'shoppingList';
      weekStart?: string | null;
      day?: Weekday | null;
      wholeWeek?: boolean;
      people?: number | null;
      checkItems?: string[] | null;
      uncheckItems?: string[] | null;
      clearChecked?: boolean;
      expandItems?: string[] | null;
      collapseItems?: string[] | null;
    }
  | { kind: 'planDay'; weekStart: string; day: Weekday | null };

export interface VoiceScreenEvent {
  focus: VoiceFocus | null;
  close: 'all' | null;
  scroll?: ScreenScrollDirection | null;
}

export type PlannerStateDomain =
  'plan' | 'shoppingList' | 'mealLog' | 'nutrition' | 'dietary';

export interface PlannerStateEvent {
  seq?: number;
  invalidate?: PlannerStateDomain[];
  patch?: {
    nutrition?: Record<string, unknown>;
    dietary?: {
      section: 'allergies' | 'preferences';
      lines: string[];
    };
  };
}

export interface VoiceTextEvent {
  text: string;
}

const PLAN_TOOLS = new Set([
  'fillSlots',
  'editPlan',
  'autoBalancePlan',
  'verifyMealPlanAllergies',
]);

const RECIPE_SECTION_SUMMARY: Record<RecipeSection, string> = {
  top: '',
  ingredients: ', ở phần nguyên liệu',
  steps: ', ở phần cách làm',
};

const SCROLL_SUMMARY: Record<ScreenScrollDirection, string> = {
  down: 'Đã cuộn xuống',
  up: 'Đã cuộn lên',
  top: 'Đã cuộn lên đầu',
  bottom: 'Đã cuộn xuống cuối',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'string' && value in DAY_NAMES;
}

function isMealSection(value: unknown): value is MealSection {
  return typeof value === 'string' && value in SECTION_NAMES;
}

function spokenDate(date: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return `ngày ${date}`;
  const month = Number(match[1]);
  const day = Number(match[2]);
  return `ngày ${day} tháng ${month}`;
}

function formatBodyMetricsDetails(
  metrics: BodyMetricsSummary | null,
): string[] {
  if (!metrics) return [];
  const details: string[] = [];
  if (typeof metrics.heightCm === 'number') {
    details.push(`chiều cao ${metrics.heightCm} cm`);
  }
  if (typeof metrics.weightKg === 'number') {
    details.push(`cân nặng ${metrics.weightKg} kg`);
  }
  if (typeof metrics.targetWeightKg === 'number') {
    details.push(`mục tiêu ${metrics.targetWeightKg} kg`);
  }
  if (typeof metrics.bmi === 'number') {
    details.push(`BMI ${metrics.bmi}`);
  }
  if (typeof metrics.dailyCalorieTarget === 'number') {
    details.push(`mục tiêu khoảng ${metrics.dailyCalorieTarget} kcal mỗi ngày`);
  }
  return details;
}

function extractPlanChange(output: unknown): {
  weekStart: string;
  applied: boolean;
  days: Weekday[];
} | null {
  if (!isRecord(output)) return null;
  if (
    typeof output.weekStart !== 'string' ||
    typeof output.applied !== 'boolean'
  ) {
    return null;
  }
  if (!Array.isArray(output.days)) return null;
  const days: Weekday[] = [];
  for (const item of output.days) {
    if (isRecord(item) && isWeekday(item.day)) {
      days.push(item.day);
    }
  }
  return { weekStart: output.weekStart, applied: output.applied, days };
}

function isSetScreenOutput(output: unknown): output is SetScreenOutput {
  if (!isRecord(output)) return false;
  return (
    typeof output.applied === 'boolean' &&
    (output.view === 'calendar' ||
      output.view === 'recipe' ||
      output.view === 'eatingLog' ||
      output.view === 'bodyMetrics' ||
      output.view === 'shoppingList')
  );
}

function screenEventFromSetScreen(
  output: SetScreenOutput,
): VoiceScreenEvent | null {
  if (!output.applied) return null;
  const event: VoiceScreenEvent = {
    focus: null,
    close: null,
    ...(output.scroll ? { scroll: output.scroll } : {}),
  };
  if (
    output.view === 'recipe' &&
    output.recipeId !== null &&
    output.title !== null
  ) {
    event.focus = {
      kind: 'recipe',
      recipeId: output.recipeId,
      title: output.title,
      section: output.section,
      ...(output.step !== undefined ? { step: output.step } : {}),
    };
    return event;
  }
  if (output.view === 'eatingLog') {
    event.focus = { kind: 'eatingLog', date: output.date };
    return event;
  }
  if (output.view === 'bodyMetrics') {
    event.focus = {
      kind: 'bodyMetrics',
      ...(output.tab ? { tab: output.tab } : {}),
      ...(output.weekStart ? { weekStart: output.weekStart } : {}),
    };
    return event;
  }
  if (output.view === 'shoppingList') {
    event.focus = {
      kind: 'shoppingList',
      ...(output.weekStart ? { weekStart: output.weekStart } : {}),
      ...(output.day !== null ? { day: output.day } : {}),
      ...(output.wholeWeek ? { wholeWeek: true } : {}),
      ...(output.people !== null ? { people: output.people } : {}),
      ...(output.checkItems && output.checkItems.length > 0
        ? { checkItems: output.checkItems }
        : {}),
      ...(output.uncheckItems && output.uncheckItems.length > 0
        ? { uncheckItems: output.uncheckItems }
        : {}),
      ...(output.clearChecked ? { clearChecked: true } : {}),
      ...(output.expandItems && output.expandItems.length > 0
        ? { expandItems: output.expandItems }
        : {}),
      ...(output.collapseItems && output.collapseItems.length > 0
        ? { collapseItems: output.collapseItems }
        : {}),
    };
    return event;
  }
  if (output.view === 'calendar') {
    event.close = 'all';
    if (output.weekStart !== null) {
      event.focus = {
        kind: 'planDay',
        weekStart: output.weekStart,
        day: output.day,
      };
    }
    return event;
  }
  return event.scroll ? event : null;
}

function summaryFromSetScreen(output: SetScreenOutput): string | null {
  if (!output.applied) return null;
  if (output.scroll) {
    return `${SCROLL_SUMMARY[output.scroll]}.`;
  }
  if (output.view === 'recipe' && output.title !== null) {
    const part =
      typeof output.step === 'number'
        ? `, ở bước ${output.step}`
        : output.section === null
          ? ''
          : RECIPE_SECTION_SUMMARY[output.section];
    return `Đã mở công thức "${output.title}" trên màn hình${part}.`;
  }
  if (output.view === 'eatingLog') {
    return output.date
      ? `Đã mở nhật ký ăn uống ${spokenDate(output.date)} trên màn hình.`
      : 'Đã mở nhật ký ăn uống hôm nay trên màn hình.';
  }
  if (output.view === 'bodyMetrics') {
    const details = formatBodyMetricsDetails(output.metrics);
    if (output.tab === 'weekly') {
      return 'Đã mở biểu đồ dinh dưỡng tuần trên màn hình.';
    }
    if (output.tab === 'dietary') {
      return 'Đã mở mục dị ứng và gu ăn uống trên màn hình.';
    }
    return details.length > 0
      ? `Đã mở bảng chỉ số cơ thể trên màn hình (${details.join(', ')}).`
      : 'Đã mở bảng chỉ số cơ thể trên màn hình.';
  }
  if (output.view === 'shoppingList') {
    if (output.expandItems && output.expandItems.length > 0) {
      return `Đã mở danh sách món dùng ${output.expandItems.join(', ')} trong danh sách đi chợ.`;
    }
    if (output.collapseItems && output.collapseItems.length > 0) {
      return `Đã thu gọn chi tiết ${output.collapseItems.join(', ')} trong danh sách đi chợ.`;
    }
    const parts: string[] = [];
    if (output.day) parts.push(DAY_NAMES[output.day]);
    else if (output.wholeWeek) parts.push('cả tuần');
    if (output.people) parts.push(`cho ${output.people} người ăn`);
    const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
    return `Đã mở danh sách đi chợ${suffix} trên màn hình.`;
  }
  if (output.view === 'calendar') {
    return output.day
      ? `Đã đóng bảng và chuyển lịch tới ${DAY_NAMES[output.day]}.`
      : 'Đã đóng các bảng và quay lại lịch thực đơn.';
  }
  return null;
}

interface ToolDerivedEffects {
  state?: PlannerStateEvent;
  screen?: VoiceScreenEvent;
  progress?: string;
  endCall?: true;
  actionSummary?: string;
  screenSummary?: string;
}

export function deriveVoiceToolEffects(
  toolName: string,
  output: unknown,
): ToolDerivedEffects {
  if (PLAN_TOOLS.has(toolName)) {
    const effects: ToolDerivedEffects = {
      state: { invalidate: ['plan', 'shoppingList'] },
    };
    const change = extractPlanChange(output);
    if (change && change.applied && change.days.length > 0) {
      effects.screen = {
        focus: {
          kind: 'planDay',
          weekStart: change.weekStart,
          day: change.days[0],
        },
        close: null,
      };
      const daysText = change.days.map((day) => DAY_NAMES[day]).join(', ');
      effects.progress = `Đã lưu thay đổi thực đơn cho ${daysText}, đang làm tiếp.`;
    }
    return effects;
  }

  if (toolName === 'updateMemory') {
    if (
      isRecord(output) &&
      (output.section === 'allergies' || output.section === 'preferences') &&
      Array.isArray(output.lines) &&
      output.lines.every((item): item is string => typeof item === 'string')
    ) {
      return {
        state: {
          patch: {
            dietary: { section: output.section, lines: output.lines },
          },
        },
      };
    }
    return {
      state: { invalidate: ['dietary'] },
    };
  }

  if (toolName === 'endCall') {
    return {
      endCall: true,
      actionSummary:
        'Người dùng muốn kết thúc cuộc gọi, hãy chào tạm biệt ngắn gọn.',
    };
  }

  if (toolName === 'setScreen' && isSetScreenOutput(output)) {
    const screen = screenEventFromSetScreen(output);
    const screenSummary = summaryFromSetScreen(output);
    return {
      ...(screen ? { screen } : {}),
      ...(screenSummary ? { screenSummary } : {}),
    };
  }

  if (toolName === 'logMeal') {
    const effects: ToolDerivedEffects = {
      state: { invalidate: ['mealLog'] },
      progress: 'Đã ghi món vào nhật ký, đang làm tiếp.',
    };
    if (isRecord(output) && isRecord(output.entry)) {
      const { date, section, name, calories } = output.entry;
      if (typeof date === 'string') {
        effects.screen = {
          focus: { kind: 'eatingLog', date },
          close: null,
        };
      }
      if (
        typeof date === 'string' &&
        typeof name === 'string' &&
        isMealSection(section)
      ) {
        const kcal =
          typeof calories === 'number' ? `, khoảng ${calories} kcal` : '';
        effects.actionSummary = `Đã ghi món "${name}" vào nhật ký bữa ${SECTION_NAMES[section]} ${spokenDate(date)}${kcal}.`;
      }
    }
    return effects;
  }

  if (toolName === 'editMealLog') {
    const effects: ToolDerivedEffects = {
      state: { invalidate: ['mealLog'] },
      progress: 'Đã cập nhật nhật ký ăn uống, đang làm tiếp.',
    };
    if (isRecord(output) && output.action === 'delete') {
      effects.actionSummary = 'Đã xóa món khỏi nhật ký ăn uống.';
      return effects;
    }
    if (
      isRecord(output) &&
      output.action === 'update' &&
      isRecord(output.entry)
    ) {
      const { date, section, name, servings } = output.entry;
      if (typeof date === 'string') {
        effects.screen = {
          focus: { kind: 'eatingLog', date },
          close: null,
        };
      }
      if (
        typeof date === 'string' &&
        typeof name === 'string' &&
        isMealSection(section) &&
        typeof servings === 'number'
      ) {
        effects.actionSummary = `Đã cập nhật món "${name}" (${servings} phần) trong nhật ký bữa ${SECTION_NAMES[section]} ${spokenDate(date)}.`;
      }
    }
    return effects;
  }

  if (toolName === 'updateBodyMetrics') {
    const metrics = isRecord(output)
      ? {
          heightCm:
            typeof output.heightCm === 'number' ? output.heightCm : null,
          weightKg:
            typeof output.weightKg === 'number' ? output.weightKg : null,
          targetWeightKg:
            typeof output.targetWeightKg === 'number'
              ? output.targetWeightKg
              : null,
          bmi: typeof output.bmi === 'number' ? output.bmi : null,
          bmiCategory: null,
          dailyCalorieTarget:
            typeof output.dailyCalorieTarget === 'number'
              ? output.dailyCalorieTarget
              : null,
        }
      : null;
    const details = formatBodyMetricsDetails(metrics);
    const nutritionPatch =
      isRecord(output) && isRecord(output.profile) ? output.profile : undefined;
    return {
      state: nutritionPatch
        ? { patch: { nutrition: nutritionPatch } }
        : { invalidate: ['nutrition'] },
      screen: { focus: { kind: 'bodyMetrics' }, close: null },
      progress: 'Đã lưu chỉ số cơ thể mới, đang làm tiếp.',
      actionSummary:
        details.length > 0
          ? `Đã lưu chỉ số cơ thể mới (${details.join(', ')}).`
          : 'Đã lưu chỉ số cơ thể mới trên màn hình.',
    };
  }

  if (toolName === 'undoLastChange') {
    const effects: ToolDerivedEffects = {
      state: { invalidate: ['plan', 'shoppingList'] },
      progress: 'Đã hoàn tác thay đổi trước đó, đang làm tiếp.',
    };
    if (isRecord(output) && Array.isArray(output.weeks)) {
      const weeks: { weekStart: string; restored: Weekday[] }[] = [];
      for (const item of output.weeks) {
        if (!isRecord(item) || typeof item.weekStart !== 'string') continue;
        const restored = Array.isArray(item.restored)
          ? item.restored.filter(isWeekday)
          : [];
        weeks.push({ weekStart: item.weekStart, restored });
      }
      const firstWeek = weeks[0];
      const firstDay = firstWeek?.restored[0];
      if (firstWeek && firstDay) {
        effects.screen = {
          focus: {
            kind: 'planDay',
            weekStart: firstWeek.weekStart,
            day: firstDay,
          },
          close: null,
        };
      }
      if (output.messageId === null || weeks.length === 0) {
        effects.actionSummary =
          'Không còn thay đổi thực đơn nào trong cuộc trò chuyện này để hoàn tác.';
      } else {
        const restoredNames: string[] = [];
        for (const week of weeks) {
          for (const day of week.restored) {
            restoredNames.push(DAY_NAMES[day]);
          }
        }
        effects.actionSummary =
          restoredNames.length > 0
            ? `Đã hoàn tác thay đổi thực đơn gần nhất cho ${restoredNames.join(', ')}.`
            : 'Đã hoàn tác thay đổi thực đơn gần nhất.';
      }
    }
    return effects;
  }

  return {};
}

function dataChunk(type: `data-${string}`, data: unknown): UIMessageChunk {
  return { type, data, transient: true };
}

export function withPlannerStreamEffects(
  stream: ReadableStream<UIMessageChunk>,
  options: { voice: boolean },
): ReadableStream<UIMessageChunk> {
  const toolNames = new Map<string, string>();
  let stateSeq = 0;
  let hasText = false;
  let lastActionSummary: string | null = null;
  let lastScreenSummary: string | null = null;

  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller) {
        if (chunk.type === 'tool-input-available') {
          toolNames.set(chunk.toolCallId, chunk.toolName);
          controller.enqueue(chunk);
          return;
        }
        if (chunk.type === 'text-delta' && chunk.delta.trim().length > 0) {
          hasText = true;
          controller.enqueue(chunk);
          return;
        }
        if (chunk.type === 'tool-output-available') {
          controller.enqueue(chunk);
          const toolName = toolNames.get(chunk.toolCallId);
          if (!toolName) return;
          const effects = deriveVoiceToolEffects(toolName, chunk.output);
          if (effects.state) {
            stateSeq += 1;
            controller.enqueue(
              dataChunk('data-state', { ...effects.state, seq: stateSeq }),
            );
          }
          if (options.voice) {
            if (effects.screen) {
              controller.enqueue(dataChunk('data-screen', effects.screen));
            }
            if (effects.progress) {
              controller.enqueue(
                dataChunk('data-progress', { text: effects.progress }),
              );
            }
            if (effects.endCall) {
              controller.enqueue(dataChunk('data-end-call', {}));
            }
            if (effects.actionSummary) {
              lastActionSummary = effects.actionSummary;
            }
            if (effects.screenSummary) {
              lastScreenSummary = effects.screenSummary;
            }
          }
          return;
        }
        if (chunk.type === 'finish') {
          if (options.voice && !hasText) {
            const summary = lastActionSummary ?? lastScreenSummary;
            if (summary) {
              controller.enqueue(dataChunk('data-summary', { text: summary }));
            }
          }
          controller.enqueue(chunk);
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
