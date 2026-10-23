import type { ToolExecutionResult } from "../types.js";

import { formatHookAdditionalContexts } from "./hook-flow.js";

export function isEmptyToolName(toolName: string): boolean {
  return toolName.trim().length === 0;
}

export function appendPreToolAdditionalContextsToErrorResult(
  result: ToolExecutionResult,
  additionalContexts: string[],
): ToolExecutionResult {
  if (result.success || !result.error || additionalContexts.length === 0) return result;

  // PreToolUse deny 和权限拒绝会在 handler 前提前返回，旧逻辑只在 handler 的
  // 成功/异常路径追加 context，导致 Hook 明明返回了 additionalContext，模型却看不到。
  const baseModelContent =
    typeof result.modelContent === "string" ? result.modelContent : result.error.message;
  return {
    ...result,
    modelContent: [baseModelContent, formatHookAdditionalContexts(additionalContexts)].join("\n\n"),
  };
}
