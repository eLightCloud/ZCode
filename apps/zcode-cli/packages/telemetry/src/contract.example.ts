import type { AgentTelemetryRuntimeOwner, TelemetryIdentitySnapshot } from "./contract.js";

/** Session 只借用进程 owner：换身份后更新投影，离开 Session 不关闭整个 exporter。 */
export async function releaseObservedSession(
  owner: AgentTelemetryRuntimeOwner,
  sessionId: string,
  identity: TelemetryIdentitySnapshot,
): Promise<void> {
  owner.updateIdentity(identity);
  owner.abandonSession(sessionId);
  await owner.flush({ timeoutMs: 1_500 });
}
