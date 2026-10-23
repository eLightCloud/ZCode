import {
  type WorkflowActivitySnapshot,
  type WorkflowGraphCollection,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
  type WorkflowPhaseSnapshot,
  type WorkflowRunSnapshot,
} from "@zcode/contracts";

export interface WorkflowGraphNodeChange {
  nodeId: string;
  phase?: string;
  status: WorkflowNodeStatus;
}

export interface WorkflowSnapshotLifecycleResult<TSnapshot extends WorkflowRunSnapshot> {
  activityIds: string[];
  changed: boolean;
  nodeChanges: WorkflowGraphNodeChange[];
  phaseIds: string[];
  snapshot: TSnapshot;
}

export interface ReconcileWorkflowSnapshotForResumeOptions {
  nodeIds?: Iterable<string>;
  reason?: string;
  resetActivities?: boolean;
  resetPhases?: boolean;
  timestamp: string;
}

export interface CancelWorkflowSnapshotOptions {
  reason?: string;
  timestamp: string;
}

export interface ReopenWorkflowGraphNodeOptions {
  maxReopens?: number;
  nodeId: string;
  reason?: string;
  timestamp: string;
}

export interface ReopenWorkflowGraphNodeResult<TSnapshot extends WorkflowRunSnapshot> {
  changed: boolean;
  nodeChange: WorkflowGraphNodeChange;
  reopenAttempts: number;
  snapshot: TSnapshot;
}

export interface ApplyWorkflowGraphSeedOptions {
  phase?: string;
  timestamp: string;
}

export interface ApplyWorkflowGraphSeedResult<TSnapshot extends WorkflowRunSnapshot> {
  addedCollections: WorkflowGraphCollection[];
  addedEdges: WorkflowGraphEdge[];
  addedNodes: WorkflowGraphNode[];
  changed: boolean;
  snapshot: TSnapshot;
}

export interface ApplyWorkflowNodePromptUpdatesOptions {
  phase: string;
  timestamp: string;
}

export interface ApplyWorkflowNodePromptUpdatesResult<TSnapshot extends WorkflowRunSnapshot> {
  changed: boolean;
  snapshot: TSnapshot;
  updatedNodes: WorkflowGraphNode[];
}

export const DEFAULT_RESUME_RESET_REASON =
  "Reset during workflow resume because the previous process stopped before completion.";

export const DEFAULT_CANCEL_REASON = "Workflow cancelled.";

export const DEFAULT_REOPEN_REASON = "Reopened by workflow critic.";

export const CANCELLABLE_STATUSES = new Set<WorkflowNodeStatus>(["active", "pending"]);

export const REOPENABLE_STATUSES = new Set<WorkflowNodeStatus>(["completed", "failed", "skipped"]);

export function isInScope(value: string, scope: ReadonlySet<string> | undefined): boolean {
  return !scope || scope.has(value);
}

export function shouldRepairPhase(
  phase: string,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  return resetPhaseIdsFromNodes.has(phase);
}

export function shouldRepairActivity(
  activity: WorkflowActivitySnapshot,
  nodeScope: ReadonlySet<string> | undefined,
  resetPhaseIdsFromNodes: ReadonlySet<string>,
): boolean {
  if (!nodeScope) return true;
  if (activity.nodeId && nodeScope.has(activity.nodeId)) return true;
  return resetPhaseIdsFromNodes.has(activity.phase);
}

export function nodeChange(
  node: WorkflowGraphNode,
  status: WorkflowNodeStatus,
): WorkflowGraphNodeChange {
  return {
    nodeId: node.id,
    ...(node.phase ? { phase: node.phase } : {}),
    status,
  };
}

export function resetPhaseForRetry(
  phase: WorkflowPhaseSnapshot,
  reason: string,
): WorkflowPhaseSnapshot {
  return {
    error: reason,
    phase: phase.phase,
    status: "pending",
  };
}

export function closePhase(
  phase: WorkflowPhaseSnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowPhaseSnapshot {
  return {
    ...phase,
    completedAt: phase.completedAt ?? timestamp,
    error: phase.error ?? reason,
    status,
  };
}

export function closeActivity(
  activity: WorkflowActivitySnapshot,
  status: WorkflowNodeStatus,
  timestamp: string,
  reason: string,
): WorkflowActivitySnapshot {
  return {
    ...activity,
    completedAt: activity.completedAt ?? timestamp,
    error: activity.error ?? reason,
    status,
  };
}
