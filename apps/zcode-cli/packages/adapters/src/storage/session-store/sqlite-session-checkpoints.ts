import type { SessionStorePort } from "@zcode/contracts";

// 端口留在领域包 @zcode/dynamic-workflow，这里只做类型引用：adapters 运行时不依赖它。

import * as textCheckpointRepository from "./repositories/text-checkpoints.js";

import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
export async function exportTextCheckpoint(
  this: SqliteSessionStoreContext,
  input: Parameters<NonNullable<SessionStorePort["exportTextCheckpoint"]>>[0],
) {
  return textCheckpointRepository.exportTextCheckpoint(this.db, input, this.checkpointLogger);
}

export async function importTextCheckpoint(
  this: SqliteSessionStoreContext,
  input: Parameters<NonNullable<SessionStorePort["importTextCheckpoint"]>>[0],
) {
  this.throwBeforeWrite();
  textCheckpointRepository.importTextCheckpoint(this.db, input, this.checkpointLogger);
}
