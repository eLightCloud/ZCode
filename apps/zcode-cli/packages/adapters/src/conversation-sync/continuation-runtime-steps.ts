import { createHash } from "node:crypto";
import {
  ConversationSyncError,
  TextCheckpointError,
  textCheckpointSchema,
  checkpointEffectReferences,
  type ConversationSyncStore,
  type SyncScope,
  type SyncVersion,
} from "@zcode/contracts";
import {
  ConversationRuntimeError,
  type ConversationRuntimePort,
  type ConversationRuntimeResult,
  type ModelSelection,
  type ConversationModelOption,
} from "@zcode/shared";
import { captureRegisteredFiles } from "./registered-files.js";
import { canonical, digest } from "./canonical.js";

export interface ConversationRuntimeDirectory {
  list(scope: SyncScope): Promise<Array<{ location: string; label: string; instanceId?: string; models?: ConversationModelOption[] }>>;
  runtime(scope: SyncScope, location: string): Promise<ConversationRuntimePort>;
}
export function continuationOperation(operation: string, step: string): string {
  const bytes = createHash("sha256")
    .update(operation + ":" + step)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function runtimeCode(error: unknown): string {
  if (
    error instanceof ConversationRuntimeError ||
    error instanceof TextCheckpointError ||
    error instanceof ConversationSyncError
  )
    return error.code;
  if (
    error &&
    typeof error === "object" &&
    "data" in error &&
    error.data &&
    typeof error.data === "object" &&
    "code" in error.data
  )
    return String(error.data.code);
  return "unavailable";
}
export async function runtimeState(
  runtime: ConversationRuntimePort,
  session: string,
  operation: string,
) {
  try {
    return await runtime.control({ kind: "read", session, operation });
  } catch (error) {
    if (["not_found", "session_not_found"].includes(runtimeCode(error))) return null;
    throw error;
  }
}
/** Rebinding a still-closed old copy requires a terminal native center intent. */
export async function reserveRuntime(
  store: ConversationSyncStore,
  scope: SyncScope,
  runtime: ConversationRuntimePort,
  session: string,
  operation: string,
  offline = false,
) {
  const previous = await runtimeState(runtime, session, operation);
  let supersedeOperation: string | undefined;
  if (
    previous &&
    previous.operation !== operation &&
    !["active", "cancelled"].includes(previous.state)
  ) {
    const old = await store.continuations?.read(scope, session, previous.operation);
    if (!old?.result || previous.state === "applied") throw new ConversationSyncError("blocked");
    if (offline && old.result.status === "ready" && old.intent.kind !== "offline")
      throw new ConversationSyncError("forward_only");
    supersedeOperation = previous.operation;
  }
  if (offline && previous && previous.generation > 0 && previous.branchMode !== "offline")
    throw new ConversationSyncError("forward_only");
  return runtime.control({
    kind: "close",
    session,
    operation,
    ...(supersedeOperation ? { supersedeOperation } : {}),
  });
}
export async function captureRuntime(
  store: ConversationSyncStore,
  scope: SyncScope,
  runtime: ConversationRuntimePort,
  location: string,
  session: string,
  operation: string,
  hint?: string,
): Promise<SyncVersion | null> {
  let captured: ConversationRuntimeResult;
  try {
    captured = await runtime.control({ kind: "capture", session, operation });
  } catch (error) {
    if (["not_found", "session_not_found"].includes(runtimeCode(error))) return null;
    throw error;
  }
  if (!captured.dataBase64 || !captured.management || captured.management.pinned === undefined)
    throw new ConversationSyncError("blocked");
  const checkpoint = textCheckpointSchema.parse(
    JSON.parse(Buffer.from(captured.dataBase64, "base64").toString("utf8")),
  );
  if((checkpoint.session.parentID??null)!==(captured.management.parentSessionId??null)) throw new ConversationSyncError("invalid");
  if (checkpoint.session.id !== session) throw new ConversationSyncError("invalid");
  const content = captured.management.deleted ? null : checkpoint;
  const files = content
    ? await captureRegisteredFiles(
        store.files,
        scope,
        session,
        checkpoint,
        runtime.content ? (uri) => runtime.content!({ kind: "read", session, uri }) : undefined,
      )
    : [];
  const base = captured.baseVersion ?? captured.version ?? hint ?? null;
  const known = base ? await store.version(scope, session, base) : null;
  if (base && !known) throw new ConversationSyncError("blocked");
  if (
    known &&
    canonical({
      checkpoint: known.checkpoint,
      management: known.management,
      files: known.files ?? [],
    }) === canonical({ checkpoint: content, management: captured.management, files })
  )
    return known;
  // A hint can prove equality, never ancestry of changed local data.
  const parent = captured.baseVersion ?? captured.version ?? null;
  const value = {
    parent,
    location,
    generation: captured.generation,
    checkpoint: content,
    management: captured.management,
    files,
  };
  const version = { id: "snapshot:" + digest(value), ...value };
  await store.execute(scope, {
    session,
    operation: continuationOperation(operation, "save:" + location),
    command: { kind: "receive", version },
  });
  return version;
}
export async function stageRuntime(
  store: ConversationSyncStore,
  scope: SyncScope,
  runtime: ConversationRuntimePort,
  session: string,
  operation: string,
  version: SyncVersion,
  branchMode: "primary" | "offline" = "primary",
  targetModel?: ModelSelection,
) {
  if (
    !version.checkpoint ||
    !version.management ||
    version.management.deleted ||
    version.management.pinned === undefined
  )
    throw new ConversationSyncError("blocked");
  for (const file of version.files ?? []) {
    if (!runtime.content || !store.files) throw new ConversationSyncError("blocked");
    const bytes = await store.files.read(scope, file);
    await runtime.content({
      kind: "restore",
      session,
      operation,
      file,
      dataBase64: Buffer.from(bytes).toString("base64"),
    });
  }
  const ownKeys=new Set(checkpointEffectReferences({...version.checkpoint,branchEffects:undefined}).map(effect=>canonical([effect.server,effect.owner,effect.operation,effect.requestKey])));
  const effects=(await store.effects?.(scope,session)??[]).filter(effect=>!ownKeys.has(canonical([effect.server,effect.owner,effect.operation,effect.requestKey])));
  const checkpoint={...version.checkpoint,...(targetModel ? {modelSelection:targetModel} : {}),...(effects.length ? {version:4 as const,branchEffects:effects} : {})};
  return runtime.control({
    kind: "stage",
    session,
    operation,
    branchMode,
    management: version.management,
    ...(version.files?.length ? { files: version.files } : {}),
    dataBase64: Buffer.from(JSON.stringify(checkpoint)).toString("base64"),
  });
}
