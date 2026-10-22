import type { NativeDeliverable } from "@zcode/shared";
import type { TraceContext } from "../tracing/tracer.js";

export interface PublishDeliverableInput {
  workspaceKey: string;
  workspacePath: string;
  sessionId: string;
  turnId?: string;
  requestKey: string;
  sourcePath: string;
  producerContextRef?: string;
  previous?: { id: string; version: number };
  trace: TraceContext;
}

/** 文件交付存储 owner；不包含执行、会话镜像或应用上传状态。 */
export interface DeliverableStorePort {
  publish(
    input: PublishDeliverableInput,
    options?: { signal?: AbortSignal },
  ): Promise<NativeDeliverable>;
  list(input: { workspaceKey: string; after: number; limit: number }): Promise<{
    entries: NativeDeliverable[];
    cursor: number;
  }>;
  read(input: {
    workspaceKey: string;
    id: string;
    version: number;
    offset: number;
    length: number;
  }): Promise<Uint8Array>;
  release(input: {
    workspaceKey: string;
    id: string;
    version: number;
    sha256: string;
  }): Promise<void>;
  close(): void;
}
