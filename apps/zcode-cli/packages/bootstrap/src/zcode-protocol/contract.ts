/** 既有协议集成合同：MCP Apps 只借用所需会话 / 事件出口，不取得 owner 的私有状态。 */
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolAgentDependencies,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
export { ProtocolRequestError, parseParams, requireSession } from "./server-types.js";
export type { ZCodeProtocolAgentDependencies } from "./server-types.js";
export type McpUiSessionRecord = Pick<ZCodeProtocolSessionRecord, "app" | "traceContext">;
export interface McpUiProtocolHost {
  readonly sessions: ReadonlyMap<string, McpUiSessionRecord>;
  readonly logger?: ZCodeProtocolAgentServerContext["logger"];
  readonly deps: Pick<ZCodeProtocolAgentDependencies, "sessionStore">;
  readonly v4Gateway?: Pick<NonNullable<ZCodeProtocolAgentServerContext["v4Gateway"]>, "ingest">;
}
