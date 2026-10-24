import type { WorkspaceFileRewindIgnoredFile, WorkspaceFileRewindPreview, WorkspaceFileRewindSafeFile, WorkspaceFileRewindUnsafeFile, WorkspaceFileRewindUnsafeReason } from "../workspace-recovery-types.js";

import { FileAggregate, FileCheckpointOperation, IgnoredFileAggregate } from "./file-rewind-types.js";

import type { WorkspaceFileRewindPlan } from "./file-rewind-types.js";

export function ensureFileAggregate(
  aggregates: Map<string, FileAggregate>,
  operation: FileCheckpointOperation,
): FileAggregate {
  const existing = aggregates.get(operation.path);
  if (existing) {
    return existing;
  }
  const aggregate: FileAggregate = {
    action: operation.action,
    operationCount: 0,
    path: operation.path,
    toolNames: new Set(),
  };
  aggregates.set(operation.path, aggregate);
  return aggregate;
}

export function markUnsafe(
  aggregates: Map<string, FileAggregate>,
  input: {
    action: "restore" | "delete";
    currentHash?: string;
    expectedHash?: string;
    message?: string;
    path: string;
    reason: WorkspaceFileRewindUnsafeReason;
    toolName: string;
  },
): void {
  const existing = aggregates.get(input.path);
  if (existing) {
    existing.operationCount += 1;
    existing.toolNames.add(input.toolName);
    existing.unsafe = {
      currentHash: input.currentHash ?? existing.unsafe?.currentHash,
      expectedHash: input.expectedHash ?? existing.unsafe?.expectedHash,
      message: input.message ?? existing.unsafe?.message,
      reason: existing.unsafe?.reason ?? input.reason,
    };
    return;
  }

  aggregates.set(input.path, {
    action: input.action,
    operationCount: 1,
    path: input.path,
    toolNames: new Set([input.toolName]),
    unsafe: {
      currentHash: input.currentHash,
      expectedHash: input.expectedHash,
      message: input.message,
      reason: input.reason,
    },
  });
}

export function addIgnoredFile(
  aggregates: Map<string, IgnoredFileAggregate>,
  path: string,
  toolName: string,
): void {
  const existing = aggregates.get(path);
  if (existing) {
    existing.operationCount += 1;
    existing.toolNames.add(toolName);
    return;
  }
  aggregates.set(path, {
    operationCount: 1,
    path,
    toolNames: new Set([toolName]),
  });
}

export function toSafeFile(file: FileAggregate): WorkspaceFileRewindSafeFile {
  return {
    action: file.action,
    operationCount: file.operationCount,
    path: file.path,
    toolNames: Array.from(file.toolNames).sort(),
  };
}

export function toUnsafeFile(file: FileAggregate): WorkspaceFileRewindUnsafeFile {
  return {
    operationCount: file.operationCount,
    path: file.path,
    reason: file.unsafe?.reason ?? "unsupported_checkpoint",
    toolNames: Array.from(file.toolNames).sort(),
    ...(file.unsafe?.message ? { message: file.unsafe.message } : {}),
    ...(file.unsafe?.expectedHash ? { expectedHash: file.unsafe.expectedHash } : {}),
    ...(file.unsafe?.currentHash ? { currentHash: file.unsafe.currentHash } : {}),
  };
}

export function toIgnoredFile(file: IgnoredFileAggregate): WorkspaceFileRewindIgnoredFile {
  return {
    operationCount: file.operationCount,
    path: file.path,
    reason: "bash_ignored",
    toolNames: Array.from(file.toolNames).sort(),
  };
}

export function compareByPath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

export function toPreview(plan: WorkspaceFileRewindPlan): WorkspaceFileRewindPreview {
  return {
    canApply: plan.canApply,
    ignoredFiles: plan.ignoredFiles,
    safeFiles: plan.safeFiles,
    unsafeFiles: plan.unsafeFiles,
  };
}
