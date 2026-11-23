import {
  DIRECT_TOOL_CALL,
  experimental_codeModeTool as codeModeTool,
  experimental_setMaxWorkers as setMaxWorkers,
} from '@ai-sdk/code-mode';
import { runtimeConfig } from '../../config/runtime-config.js';

/**
 * Experimental: with PLANNER_CODE_MODE=1 the planner may batch its read-only
 * tools in one sandboxed program instead of one model step per call.
 *
 * Only tools that read the user's own data are routed through it, and they
 * stay directly callable so the chat still shows recipe cards. Tools that
 * write, wait for the user (askUser), run at the provider (web search) or
 * return untrusted document text (searchKnowledge) stay direct only.
 */
export const isPlannerCodeModeEnabled = runtimeConfig.PLANNER_CODE_MODE === 1;

if (isPlannerCodeModeEnabled) {
  setMaxWorkers(runtimeConfig.PLANNER_CODE_MODE_MAX_WORKERS);
}

export const PLANNER_CODE_MODE_CALLERS = {
  searchRecipes: ['code_mode', DIRECT_TOOL_CALL],
  getRecipe: ['code_mode', DIRECT_TOOL_CALL],
  getPlan: ['code_mode', DIRECT_TOOL_CALL],
} as const;

export const PLANNER_CODE_MODE_NOTE = `

Công cụ code_mode: khi cần đọc nhiều lần (getPlan, searchRecipes, getRecipe), gộp chúng vào một chương trình code_mode, gọi song song bằng Promise.all và chỉ return các trường cần dùng (id, title, kcal, ngày…), không trả nguyên dữ liệu. Một lần đọc đơn lẻ thì gọi trực tiếp. Các công cụ sửa thực đơn, askUser, hồ sơ, searchKnowledge và web vẫn gọi trực tiếp.`;

export function plannerCodeModeTool() {
  return codeModeTool({
    toolDiscovery: 'conversation',
    executionPolicy: {
      timeoutMs: runtimeConfig.PLANNER_CODE_MODE_TIMEOUT_MS,
      maxBridgeRequests: runtimeConfig.PLANNER_CODE_MODE_MAX_TOOL_CALLS,
      maxInFlightBridgeRequests: 8,
      maxResultBytes: 256 * 1024,
    },
  });
}
