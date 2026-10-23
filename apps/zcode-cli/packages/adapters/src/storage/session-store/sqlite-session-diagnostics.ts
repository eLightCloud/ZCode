import type { SessionId } from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import type { SessionStoreDebugCounts } from "./options.js";

import * as debugRepository from "./repositories/debug.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export function debugMigrationIds(this: SqliteSessionStoreContext): string[] {
  return debugRepository.debugMigrationIds(this.db);
}

export function debugCounts(
  this: SqliteSessionStoreContext,
  sessionID?: SessionId,
): SessionStoreDebugCounts {
  return debugRepository.debugCounts(this.db, sessionID);
}
