import type { SessionEvent } from "@zcode/contracts";
import type { ProductProjection } from "./product-projection.js";
import type { ProjectionPayloadTooLargeError } from "./topic-publisher-support.js";
import type { LogEntry } from "./topic-publisher-support.js";
import type { Subscription } from "./topic-publisher-support.js";
import type { ConversationDelta } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTopicFrame } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationPlansResult } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationRowsRangeResult } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowTargetResolution } from "./product-projection.js";
import type { StableForkCandidateResolution } from "./product-projection.js";
import type { TopicFrameReservation } from "./topic-frame-reservation.js";
import type { ConversationSubscribeResult } from "./topic-publisher-support.js";
import type { SubscribeAck } from "@zcode/shared/zcode-protocol-v4";
import type { TopicFrameDeliveryKind } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationSubscriberBufferLimits } from "./topic-publisher-support.js";
import type { ConversationResyncRequest } from "./topic-publisher-support.js";
import type { ConversationRowTarget } from "@zcode/shared/zcode-protocol-v4";
import type { DeliveryProfileName } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRowTargetAction } from "./product-projection.js";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type { DeliveryProfile } from "@zcode/shared/zcode-protocol-v4";
import type { SessionConfigSeed } from "./product-projection.js";
import type { SessionSubagentsSeed } from "./product-projection.js";
import type { SessionUsageSeed } from "./product-projection.js";
import type { ConversationSubscribeParams } from "./topic-publisher-support.js";

/** 同一 owner 的唯一内部状态 / 协作形状；不从实现类反向取型。 */
export interface ConversationTopicPublisherMethodsContext {
  ackFor(subscription: Subscription, mode: SubscribeAck["mode"]): SubscribeAck;
  appendDeltas(seq: number, deltas: ConversationDelta[]): void;
  connectionIdForSubscription(subscriptionId: string): string | null;
  readonly currentSeq: number;
  encodeDeltasForSubscription(
    deltas: readonly ConversationDelta[],
    subscription: Subscription,
  ): readonly ConversationDelta[];
  floorSeq: number;
  flush(subscriptionId: string): ConversationTopicFrame | null;
  frameShell(
    subscription: Subscription,
  ): Pick<ConversationTopicFrame, "topic" | "subscriptionId" | "sentAt">;
  getDroppedContentStreamEventCount(): number;
  getMessageIdForRow(rowId: number): string | null;
  getMessageIdsForTurnRow(rowId: number): string[];
  getPlans(): V4ConversationPlansResult;
  getRowsRange(
    params: { beforeRowId?: number; limit: number },
    deliveryProfile?: DeliveryProfileName,
  ): V4ConversationRowsRangeResult;
  getSnapshot(): ConversationSnapshot;
  getTurnIdForRow(rowId: number): string | null;
  getTurnRewindAnchor(rowId: number): string | null;
  getWireSnapshot(snapshot?: ConversationSnapshot): ConversationSnapshot;
  getWireSnapshotForProfile(
    profile: DeliveryProfile,
    snapshot?: ConversationSnapshot,
  ): ConversationSnapshot;
  getWireSnapshotForSubscription(subscription: Subscription): ConversationSnapshot;
  getWireSnapshotLogicalBytes(): number;
  hasSubscribers(): boolean;
  hasSubscription(subscriptionId: string, connectionId?: string): boolean;
  ingest(event: SessionEvent): void;
  isLatestAssistantSegmentRow(rowId: number): boolean;
  isLatestEditableUserRow(rowId: number): boolean;
  isLatestRetryAssistantRow(rowId: number): boolean;
  readonly log: LogEntry[];
  readonly logEpoch: string;
  measureInputAdmissionProjectionBytes(
    envelope: CommandEnvelope,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): number | null;
  measureWireSnapshotBytes(snapshot: ConversationSnapshot): number;
  nextLogicalFrameSerial: number;
  nextSubscriptionSerial: number;
  readonly now: () => number;
  projection: ProductProjection;
  projectionLimitForEvent(event: SessionEvent): number;
  rehydrate(
    events: readonly SessionEvent[],
    options?: { onPayloadTooLarge?: (error: ProjectionPayloadTooLargeError) => void },
  ): void;
  reserveFlush(subscriptionId: string): TopicFrameReservation<ConversationTopicFrame> | null;
  reserveFrame(
    subscription: Subscription,
    frame: ConversationTopicFrame,
    snapshotRecovery: boolean,
    deliveryKind: TopicFrameDeliveryKind,
  ): TopicFrameReservation<ConversationTopicFrame>;
  resolveRowActionTarget(
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution;
  resolveStableForkCandidate(rowId: number): StableForkCandidateResolution;
  resync(subscriptionId: string): ConversationTopicFrame | null;
  resyncReserved(
    subscriptionId: string,
    request: ConversationResyncRequest,
  ): ConversationSubscribeResult | null;
  resyncRollback(
    subscription: Subscription,
    reservation: TopicFrameReservation<ConversationTopicFrame>,
    previous: Pick<
      Subscription,
      "buffer" | "bufferBytes" | "resyncRequired" | "sentSeq" | "inFlight"
    >,
  ): () => boolean;
  readonly retention: number;
  seedConfig(seed: SessionConfigSeed): void;
  seedSharedContextImport(
    source: ConversationSnapshot["sharedContextImport"] | null | undefined,
  ): void;
  seedSubagents(seed: SessionSubagentsSeed): void;
  seedUsage(seed: SessionUsageSeed): void;
  readonly sessionId: string;
  subscribe(params: ConversationSubscribeParams): ConversationSubscribeResult;
  subscribeReserved(params: ConversationSubscribeParams): ConversationSubscribeResult;
  subscribeResult(
    ack: SubscribeAck,
    reservation: TopicFrameReservation<ConversationTopicFrame> | null,
    rollback: () => boolean,
  ): ConversationSubscribeResult;
  subscriberBufferLimits(): ConversationSubscriberBufferLimits;
  readonly subscriberBufferMaxBytes: number;
  readonly subscriberBufferMaxOps: number;
  readonly subscriptionIdByConnection: Map<string, string>;
  readonly subscriptions: Map<string, Subscription>;
  readonly topic: string;
  tryBatchHydration(events: readonly SessionEvent[]): boolean;
  unsubscribe(subscriptionId: string, connectionId?: string): void;
  wireSnapshotBytesUpperBound: number;
}
