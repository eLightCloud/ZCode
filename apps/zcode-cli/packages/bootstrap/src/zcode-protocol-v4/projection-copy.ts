import type { ProductProjection } from "./product-projection.js";
import type { ProductProjectionContext } from "./projection-context.js";

// 保留原子投影副本的字段级复制与 adoption，不复制 owner 或引入第二状态。
export function cloneProjectionState(
  this: ProductProjectionContext,
  prototype: object,
): ProductProjection {
  const clone = Object.create(prototype) as ProductProjectionContext;
  clone.snapshot = this.snapshot;
  clone.rowIndexById = new Map(this.rowIndexById);
  clone.hydrationAccumulator = null;
  clone.nextRowId = this.nextRowId;
  clone.streamingTextRowId = this.streamingTextRowId;
  clone.streamingReasoningRowId = this.streamingReasoningRowId;
  clone.outputContinuationTextRowId = this.outputContinuationTextRowId;
  clone.toolRowIdByCallId = new Map(this.toolRowIdByCallId);
  // 实时发布逐事件走原子 clone；遗漏该侧表会让成功的 list_apps 快照在提交时丢失。
  clone.latestListAppsSnapshot = new Map(this.latestListAppsSnapshot);
  clone.openForegroundToolCallIds = new Set(this.openForegroundToolCallIds);
  clone.fileToolInputPreviewByCallId = new Map(
    [...this.fileToolInputPreviewByCallId].map(([toolCallId, state]) => [toolCallId, { ...state }]),
  );
  clone.subagentRowIdByAgentId = new Map(this.subagentRowIdByAgentId);
  clone.hookRowIdByInvocationId = new Map(this.hookRowIdByInvocationId);
  clone.pendingSessionHookInvocations = new Map(
    [...this.pendingSessionHookInvocations].map(([invocationId, pending]) => [
      invocationId,
      {
        firstEvent: pending.firstEvent,
        content: {
          ...pending.content,
          executions: pending.content.executions.map((execution) => ({ ...execution })),
        },
      },
    ]),
  );
  clone.rewoundHookInvocationIds = new Set(this.rewoundHookInvocationIds);
  clone.invalidSubagentChildSessionIds = new Set(this.invalidSubagentChildSessionIds);
  clone.messageIdByRowId = new Map(this.messageIdByRowId);
  clone.outputContinuationRowIdByMessageId = new Map(this.outputContinuationRowIdByMessageId);
  clone.entityIdByRowId = new Map(this.entityIdByRowId);
  clone.editTargetByEntityId = new Map(this.editTargetByEntityId);
  clone.currentEditableEntityId = this.currentEditableEntityId;
  clone.stableCompactCoverageBoundaryRowId = this.stableCompactCoverageBoundaryRowId;
  clone.turnHeaderRowIdByTurnId = new Map(this.turnHeaderRowIdByTurnId);
  clone.compactMarkerRowIdByOperationId = new Map(this.compactMarkerRowIdByOperationId);
  clone.goalVerifyMarkerRowIdByLifecycleKey = new Map(this.goalVerifyMarkerRowIdByLifecycleKey);
  clone.productTurnIdByRuntimeTurnId = new Map(this.productTurnIdByRuntimeTurnId);
  clone.runtimeTurnIdByProductTurnId = new Map(this.runtimeTurnIdByProductTurnId);
  clone.productTurnSplitOrdinalByRuntimeTurnId = new Map(
    this.productTurnSplitOrdinalByRuntimeTurnId,
  );
  clone.currentProductTurnStartedAtMs = this.currentProductTurnStartedAtMs;
  clone.highspeedModelDurationByTurnId = new Map(this.highspeedModelDurationByTurnId);
  clone.highspeedToolIntervalsByTurnId = new Map(
    [...this.highspeedToolIntervalsByTurnId].map(([turnId, intervals]) => [
      turnId,
      new Map([...intervals].map(([toolCallId, interval]) => [toolCallId, { ...interval }])),
    ]),
  );
  clone.deliveryByPendingInputId = new Map(this.deliveryByPendingInputId);
  clone.currentTurnId = this.currentTurnId;
  clone.currentTurnStartedModelOnly = this.currentTurnStartedModelOnly;
  clone.contextWindowState = { ...this.contextWindowState };
  clone.lastTurnModel = { ...this.lastTurnModel };
  clone.configModelTouchedByEvent = this.configModelTouchedByEvent;
  clone.configThoughtLevelsTouchedByEvent = this.configThoughtLevelsTouchedByEvent;
  clone.configModeTouchedByEvent = this.configModeTouchedByEvent;
  clone.droppedContentStreamEventCount = this.droppedContentStreamEventCount;
  clone.normalizationDiagnostics = [...this.normalizationDiagnostics];
  return clone as unknown as ProductProjection;
}

export function adoptProjectionState(
  this: ProductProjectionContext,
  candidate: ProductProjectionContext,
): void {
  this.snapshot = candidate.snapshot;
  this.rowIndexById = candidate.rowIndexById;
  this.hydrationAccumulator = null;
  this.nextRowId = candidate.nextRowId;
  this.streamingTextRowId = candidate.streamingTextRowId;
  this.streamingReasoningRowId = candidate.streamingReasoningRowId;
  this.outputContinuationTextRowId = candidate.outputContinuationTextRowId;
  this.toolRowIdByCallId = candidate.toolRowIdByCallId;
  this.latestListAppsSnapshot = candidate.latestListAppsSnapshot;
  this.openForegroundToolCallIds = candidate.openForegroundToolCallIds;
  this.fileToolInputPreviewByCallId = candidate.fileToolInputPreviewByCallId;
  this.subagentRowIdByAgentId = candidate.subagentRowIdByAgentId;
  this.hookRowIdByInvocationId = candidate.hookRowIdByInvocationId;
  this.pendingSessionHookInvocations = candidate.pendingSessionHookInvocations;
  this.rewoundHookInvocationIds = candidate.rewoundHookInvocationIds;
  this.invalidSubagentChildSessionIds = candidate.invalidSubagentChildSessionIds;
  this.messageIdByRowId = candidate.messageIdByRowId;
  this.outputContinuationRowIdByMessageId = candidate.outputContinuationRowIdByMessageId;
  this.entityIdByRowId = candidate.entityIdByRowId;
  this.editTargetByEntityId = candidate.editTargetByEntityId;
  this.currentEditableEntityId = candidate.currentEditableEntityId;
  this.stableCompactCoverageBoundaryRowId = candidate.stableCompactCoverageBoundaryRowId;
  this.turnHeaderRowIdByTurnId = candidate.turnHeaderRowIdByTurnId;
  this.compactMarkerRowIdByOperationId = candidate.compactMarkerRowIdByOperationId;
  this.goalVerifyMarkerRowIdByLifecycleKey = candidate.goalVerifyMarkerRowIdByLifecycleKey;
  this.productTurnIdByRuntimeTurnId = candidate.productTurnIdByRuntimeTurnId;
  this.runtimeTurnIdByProductTurnId = candidate.runtimeTurnIdByProductTurnId;
  this.productTurnSplitOrdinalByRuntimeTurnId = candidate.productTurnSplitOrdinalByRuntimeTurnId;
  this.currentProductTurnStartedAtMs = candidate.currentProductTurnStartedAtMs;
  this.highspeedModelDurationByTurnId = candidate.highspeedModelDurationByTurnId;
  this.highspeedToolIntervalsByTurnId = candidate.highspeedToolIntervalsByTurnId;
  this.deliveryByPendingInputId = candidate.deliveryByPendingInputId;
  this.currentTurnId = candidate.currentTurnId;
  this.currentTurnStartedModelOnly = candidate.currentTurnStartedModelOnly;
  this.contextWindowState = candidate.contextWindowState;
  this.lastTurnModel = candidate.lastTurnModel;
  this.configModelTouchedByEvent = candidate.configModelTouchedByEvent;
  this.configThoughtLevelsTouchedByEvent = candidate.configThoughtLevelsTouchedByEvent;
  this.configModeTouchedByEvent = candidate.configModeTouchedByEvent;
  this.droppedContentStreamEventCount = candidate.droppedContentStreamEventCount;
  this.normalizationDiagnostics = candidate.normalizationDiagnostics;
}
