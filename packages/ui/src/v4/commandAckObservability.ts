/**
 * v4 命令 ack 可观测性：生产构建下 renderer 日志整体关闭（见 ui/logger.ts），
 * e2e/现场排查需要一个可 probe 的收口。这里把每条命令的 ack 摘要写进 window 上的
 * 有界环形缓冲（与 __zcodeSessionStoreE2E 同口径的调试面），不含消息正文等重 payload。
 */
import { getRemoteConnectionFailureCode } from "@/lib/remoteWorkspaceServiceError.js";

export interface V4CommandFailureDiagnostics {
  reasonCode: string;
  source: "application-input" | "transport";
  nativeDispatch?: "not_started";
  stage?: string;
  reason?: "timeout" | "cancelled" | "failed";
}

/** 错误正文可能含服务端秘密；公开诊断只读取受限结构化字段，不解析 message。 */
export function getV4CommandFailureDiagnostics(error: unknown): V4CommandFailureDiagnostics {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ApplicationInputRejected" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/.test(error.code)
  ) {
    const stage = "stage" in error ? error.stage : undefined;
    const reason = "reason" in error ? error.reason : undefined;
    return {
      reasonCode: error.code,
      source: "application-input",
      nativeDispatch: "not_started",
      ...(typeof stage === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(stage) ? { stage } : {}),
      ...(reason === "timeout" || reason === "cancelled" || reason === "failed" ? { reason } : {}),
    };
  }
  return {
    reasonCode: getRemoteConnectionFailureCode(error) ?? "transport_error",
    source: "transport",
  };
}

export interface V4CommandAckSummary {
  type: string;
  status: string;
  reasonCode?: string;
  source?: V4CommandFailureDiagnostics["source"];
  nativeDispatch?: V4CommandFailureDiagnostics["nativeDispatch"];
  stage?: string;
  reason?: V4CommandFailureDiagnostics["reason"];
  revisionAtDecision?: number;
  at: number;
}

const MAX_ACK_ENTRIES = 50;

type V4AckDebugWindow = Window & {
  __zcodeV4CommandAcksE2E?: V4CommandAckSummary[];
};

export function recordV4CommandAck(summary: V4CommandAckSummary): void {
  if (typeof window === "undefined") return;
  const host = window as V4AckDebugWindow;
  const buffer = (host.__zcodeV4CommandAcksE2E ??= []);
  buffer.push(summary);
  if (buffer.length > MAX_ACK_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ACK_ENTRIES);
  }
}
