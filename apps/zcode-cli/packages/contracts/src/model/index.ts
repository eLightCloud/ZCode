// ============================================================
// Model Protocol - provider-neutral model contracts
// ============================================================

import { ModelToolCall } from "./message-content.js";

export {
  createModelId,
  createModelProviderId,
  ModelRequestSessionType,
  ModelRetryBudget,
} from "./request-identity.js";

export type {
  JsonSchema,
  ModelId,
  ModelProviderId,
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "./request-identity.js";

export {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  ModelRetryReason,
  ModelTransportKind,
} from "./network-status.js";

export type {
  ModelNetworkStatusEvent,
  ModelRequestAdmittedStatusEvent,
  ModelRequestCompletedStatusEvent,
  ModelRequestFailedStatusEvent,
  ModelRequestObservation,
  ModelRequestObservationStatusEvent,
  ModelRequestQueuedStatusEvent,
  ModelRequestStartedStatusEvent,
  ModelRetryScheduledStatusEvent,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  ModelStreamStalledStatusEvent,
  ModelTelemetryMilestoneStatusEvent,
} from "./network-status.js";

export { modelMessageContentBlockToText, modelMessageContentToText } from "./message-content.js";

export type {
  AttachmentKind,
  AttachmentRef,
  ModelCacheControl,
  ModelFileContentBlock,
  ModelImageContentBlock,
  ModelInputMessage,
  ModelMessageContent,
  ModelMessageContentBlock,
  ModelMessageRole,
  ModelReasoningContentBlock,
  ModelResourceLinkContentBlock,
  ModelTextContentBlock,
  ModelToolCall,
  ModelVideoContentBlock,
} from "./message-content.js";

export type {
  ModelRequestSettings,
  ModelSource,
  ModelStreamEvent,
  ModelTextRequest,
  ModelTextResult,
  ModelToolChoice,
  ModelToolContract,
  ModelToolExecutionContext,
  ModelToolResult,
  ModelToolSideEffectScope,
} from "./request-contract.js";

export {
  createModelUsageSummary,
  getModelUsageContextTokens,
  getModelUsageInputWindowTokens,
  getModelUsageTotalTokens,
  hasModelUsage,
} from "./usage.js";

export type { ModelServerToolUsage, ModelUsage, ModelUsageSummary } from "./usage.js";

export {
  modelInputMessageJsonSchema,
  modelNetworkStatusEventJsonSchema,
  modelSelectionJsonSchema,
  modelTextRequestJsonSchema,
} from "./request-schema.js";

export * from "./image-media.js";

export * from "./model.js";

export * from "./invocation-context.js";

// Re-export for backwards compatibility with code using ToolCall
export type { ModelToolCall as ToolCall };

export * from "./content-protection.js";
