import * as permissionFullAccessRepository from "./repositories/permission-full-access.js";

import type {
  CollaborationMode,
  PermissionRuleset,
  ProjectId,
  SessionStorePort,
} from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import * as localSettingsRepository from "./repositories/local-settings.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export async function commitPermissionFullAccess(
  this: SqliteSessionStoreContext,
  input: Parameters<NonNullable<SessionStorePort["commitPermissionFullAccess"]>>[0],
): Promise<void> {
  this.throwBeforeWrite();
  return permissionFullAccessRepository.commitPermissionFullAccess(this.db, input);
}

export async function getProjectPermission(
  this: SqliteSessionStoreContext,
  projectID: ProjectId,
): Promise<PermissionRuleset | null> {
  return localSettingsRepository.getProjectPermission(this.db, projectID);
}

export async function saveProjectPermission(
  this: SqliteSessionStoreContext,
  input: {
    projectID: ProjectId;
    permission: PermissionRuleset;
  },
): Promise<PermissionRuleset> {
  return localSettingsRepository.saveProjectPermission(this.db, input);
}

export function getProjectPermissionMode(
  this: SqliteSessionStoreContext,
  projectID: ProjectId,
): CollaborationMode | null {
  return localSettingsRepository.getProjectPermissionMode(this.db, projectID);
}

export function saveProjectPermissionMode(
  this: SqliteSessionStoreContext,
  input: {
    mode: CollaborationMode;
    projectID: ProjectId;
  },
): CollaborationMode {
  return localSettingsRepository.saveProjectPermissionMode(this.db, input);
}
