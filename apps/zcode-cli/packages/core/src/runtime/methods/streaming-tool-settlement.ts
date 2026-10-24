import type { ModelToolCall } from "../deps.js";

import type { StreamedToolExecutionResult } from "../model-execution-types.js";

export const STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS = 250;

export async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function collectCompletedResults(
  handles: Map<string, Promise<StreamedToolExecutionResult | undefined>>,
  toolCalls: readonly ModelToolCall[],
): Promise<StreamedToolExecutionResult[]> {
  const settled = await Promise.all(
    toolCalls.map((toolCall) => {
      const handle = handles.get(toolCall.id);
      if (!handle) return undefined;
      return raceWithTimeout(
        handle.catch(() => undefined),
        STREAMING_TOOL_CANCEL_DRAIN_TIMEOUT_MS,
      );
    }),
  );
  return settled.filter((result): result is StreamedToolExecutionResult => result !== undefined);
}
