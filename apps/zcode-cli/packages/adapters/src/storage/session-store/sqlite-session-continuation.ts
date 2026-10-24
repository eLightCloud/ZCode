import type { SessionContinuationStorePort } from "@zcode/contracts";
import type { SqliteSessionStoreContext } from "./sqlite-session-context.js";
import { controlContinuation as control } from "./repositories/continuation.js";

export async function controlContinuation(
  this: SqliteSessionStoreContext,
  ...args: Parameters<SessionContinuationStorePort["controlContinuation"]>
) {
  this.throwBeforeWrite();
  return control(this.db, ...args, this.checkpointLogger);
}
