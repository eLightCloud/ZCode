import type { McpServerConfig, McpServerStatus } from "@zcode/contracts";

import { createHash } from "node:crypto";

import type { McpServerRecord } from "./mcp-adapter-contract.js";

import type { NodeMcpAdapterContext } from "./mcp-adapter-context.js";
export function onAppConnectionInvalidated(
  this: NodeMcpAdapterContext,
  name: string,
  listener: () => void,
): () => void {
  const listeners = this.appConnectionListeners.get(name) ?? new Set();
  listeners.add(listener);
  this.appConnectionListeners.set(name, listeners);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) this.appConnectionListeners.delete(name);
  };
}

export function appConnectionSnapshot(
  this: NodeMcpAdapterContext,
  name: string,
): { identity: string; generation: number } | null {
  const record = this.records.get(name);
  if (!record?.client || record.status.status !== "connected") return null;
  // 只向宿主输出摘要；配置中的凭据不进入协议或日志。属性排序避免配置序列化次序造成换源。
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return value;
  };
  return {
    identity: createHash("sha256")
      .update(
        JSON.stringify([
          process.platform,
          process.execPath,
          this.workingDirectory ?? "",
          name,
          canonical(record.config),
        ]),
      )
      .digest("hex"),
    generation: this.connectionGenerations.get(name) ?? 0,
  };
}

export function nextConnectionGeneration(this: NodeMcpAdapterContext, name: string): number {
  const generation = (this.connectionGenerations.get(name) ?? 0) + 1;
  this.connectionGenerations.set(name, generation);
  // eslint-disable-next-line unicorn/no-useless-spread -- 回调可能增删监听器，本次通知必须固定接收者。
  for (const listener of [...(this.appConnectionListeners.get(name) ?? [])]) listener();
  return generation;
}

export function isCurrentConnection(
  this: NodeMcpAdapterContext,
  name: string,
  generation: number,
): boolean {
  return this.connectionGenerations.get(name) === generation;
}

export function updateCurrentRecord(
  this: NodeMcpAdapterContext,
  name: string,
  generation: number,
  patch: Partial<Pick<McpServerRecord, "client" | "transport">>,
): void {
  if (!this.isCurrentConnection(name, generation)) return;
  const record = this.records.get(name);
  if (!record) return;
  Object.assign(record, patch);
}

export function updateCurrentRecordStatus(
  this: NodeMcpAdapterContext,
  name: string,
  generation: number,
  patch: Partial<McpServerStatus>,
): void {
  if (!this.isCurrentConnection(name, generation)) return;
  const record = this.records.get(name);
  if (!record) return;
  record.status = {
    ...record.status,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
}

export function createStatus(
  this: NodeMcpAdapterContext,
  config: McpServerConfig,
  status: McpServerStatus["status"],
  extra: {
    authorization?: McpServerStatus["authorization"];
    error?: string;
    failureKind?: McpServerStatus["failureKind"];
    protocolEra?: McpServerStatus["protocolEra"];
    serverRequestId?: string;
    toolCount?: number;
  } = {},
): McpServerStatus {
  return {
    status,
    transport: config.type,
    toolCount: extra.toolCount ?? 0,
    updatedAt: new Date().toISOString(),
    authorization: extra.authorization,
    error: extra.error,
    failureKind: extra.failureKind,
    protocolEra: extra.protocolEra,
    serverRequestId: extra.serverRequestId,
  };
}
