import type { MarketplaceOperationSignalScope } from "./marketplace-contracts.js";

import {
  CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS,
  CLAUDE_OFFICIAL_MARKETPLACE,
} from "./marketplace-constants.js";

export function throwIfPluginOperationAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createPluginOperationCancelledError();
  }
}

export function createPluginOperationCancelledError(): Error {
  const error = new Error("Plugin operation cancelled");
  error.name = "AbortError";
  return error;
}

// Claude 官方市场只提供可选目录，外部网络不可达时必须中止底层请求，不能拖住其他插件市场。
export function createMarketplaceOperationSignalScope(
  trustedId: string | undefined,
  externalSignal?: AbortSignal,
): MarketplaceOperationSignalScope {
  if (trustedId !== CLAUDE_OFFICIAL_MARKETPLACE) {
    return {
      cleanup: () => {},
      signal: externalSignal,
      timedOut: false,
      timeoutError: new Error("Marketplace operation timed out"),
    };
  }

  const controller = new AbortController();
  const timeoutError = new Error(
    `Claude marketplace refresh timed out after ${CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS / 1000} seconds`,
  );
  timeoutError.name = "TimeoutError";
  const scope: MarketplaceOperationSignalScope = {
    cleanup: () => {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", abortExternal);
    },
    signal: controller.signal,
    timedOut: false,
    timeoutError,
  };
  const abortExternal = (): void => {
    controller.abort(externalSignal?.reason);
  };
  const timeout = setTimeout(() => {
    scope.timedOut = true;
    controller.abort(timeoutError);
  }, CLAUDE_MARKETPLACE_REFRESH_TIMEOUT_MS);

  if (externalSignal?.aborted) {
    abortExternal();
  } else {
    externalSignal?.addEventListener("abort", abortExternal, { once: true });
  }
  return scope;
}
