import type { McpPort, McpServerStatus } from "@zcode/contracts";

import type { McpConnectionContext } from "./pool.js";

export interface PoolEntry {
  adapter: McpPort;
  closeTimer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  connectionContext: McpConnectionContext;
  connecting: Promise<McpServerStatus>;
  key: string;
  refs: Set<string>;
  /** 同一 entry 的并发存活校验共享一次探测，避免重复 ping / 重复重连。 */
  revalidating?: Promise<void>;
  serverName: string;
}
