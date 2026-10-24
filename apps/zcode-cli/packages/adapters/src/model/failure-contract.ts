import type { ModelErrorCode as ModelErrorCodeType, ModelFailureReason, ModelRetryReason } from "@zcode/contracts";

// 适配器内部的唯一数据形状，调用方不从实现反向取型。
export interface ClassifiedModelFailure {
  code: ModelErrorCodeType;
  message: string;
  reason: ModelFailureReason;
  retryReason: ModelRetryReason;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
}

export interface ProviderFailureDetails {
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
}
