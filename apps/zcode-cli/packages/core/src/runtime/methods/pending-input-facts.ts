import { CoreErrorType, createCoreError } from "../deps.js";

import type { PendingTurnInput, TurnId, TurnSteerInput } from "../deps.js";

import type { ActiveTurnKind, ActiveTurnSteeringState } from "../types.js";

import type { AgentRuntimeInternal } from "../internal.js";

export function hasSteerInput(
  request: Pick<TurnSteerInput, "attachments" | "input" | "intent">,
): boolean {
  return (
    request.input.trim().length > 0 ||
    Boolean(request.attachments?.length) ||
    Boolean(request.intent?.conversationQuotes?.length)
  );
}

export function createPendingInputId(this: AgentRuntimeInternal, turnId: TurnId): string {
  this.pendingInputSequence += 1;
  return `pending_${turnId}_${this.pendingInputSequence}`;
}

export function createTurnInProgressError(
  kind: ActiveTurnKind,
  activeTurnId: TurnId,
  nextTurnId: TurnId,
): Error {
  return createCoreError(
    CoreErrorType.TurnInProgress,
    `Cannot start ${kind} turn while another turn is active`,
    {
      context: {
        activeTurnId,
        nextTurnId,
      },
      recoverable: true,
    },
  );
}

export function hasPendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  return this.activeTurn === activeTurn && activeTurn.pendingInputs.length > 0;
}

export function pendingInputDelivery(
  pendingInput: PendingTurnInput | undefined,
): "guide" | "queue" {
  const delivery = pendingInput?.delivery ?? pendingInput?.intent?.admittedDelivery;
  return delivery === "guide" ? "guide" : "queue";
}

export function firstInlineGuideIndex(activeTurn: ActiveTurnSteeringState): number {
  // pendingInputs 同时承载 future queue 与 current-turn guide，只检查
  // 数组队首，导致先入队的普通消息把后续显式 guide 永久挡住。delivery 才是消费车道；
  // 这里只在 guide 子序列内保持 admission FIFO，普通 queue 留在原位等待外层提升。
  return activeTurn.pendingInputs.findIndex(
    (pendingInput) =>
      pendingInput.commandKind !== "sendGoalCommand" &&
      pendingInput.commandKind !== "compact" &&
      pendingInputDelivery(pendingInput) === "guide",
  );
}

export function hasInlineGuidePendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  const guideIndex = firstInlineGuideIndex(activeTurn);
  const pendingInput = guideIndex >= 0 ? activeTurn.pendingInputs[guideIndex] : undefined;
  return (
    this.activeTurn === activeTurn &&
    !this.permissionFullAccessPending &&
    !this.queueExternalDrainActive &&
    !this.pendingInputReservations.has(pendingInput?.id ?? "") &&
    pendingInput?.commandKind !== "sendGoalCommand" &&
    pendingInput?.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

export async function pendingInputTargetTurnId(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
): Promise<TurnId | undefined> {
  const active = runtime.activeTurn?.pendingInputs.find((item) => item.id === pendingInputId);
  if (active) return active.turnId;
  const projection = await runtime.rebuildProjection();
  return projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId)
    ?.targetTurnId;
}
