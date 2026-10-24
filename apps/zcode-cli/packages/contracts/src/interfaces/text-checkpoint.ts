import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { z } from "zod";
import { compactBoundaryPayloadSchema } from "../compact/index.js";
import { completedToolPartMetadataSchema } from "../tools/tool-result-metadata.js";
import type { ProjectId, SessionId, WorkspaceId } from "./shared.js";
import { portableFilePayload, portableFileMetadata, portableFileIntent } from "./text-input-facts.js";
import { conversationEffectSchema, type ConversationEffect, conversationArtifactUriSchema, conversationSessionIdSchema } from "@zcode/shared";

const id = z.string().min(1);
const timestamp = z.number().int().nonnegative();
// Shared 使用独立的 Zod 主版本；复用唯一模型校验器，不复制字段。
const selection = z.custom<ModelSelection>(
  (value) => modelSelectionSchema.safeParse(value).success,
);
const tokens = z
  .object({
    total: z.number().nonnegative().optional(),
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    reasoning: z.number().nonnegative(),
    cache: z.object({ read: z.number().nonnegative(), write: z.number().nonnegative() }).strict(),
  })
  .strict();
const anchor = z
  .object({
    turnId: id.optional(),
    origin: z.enum(["realUser", "synthetic"]).optional(),
    sourceCommandId: id.optional(),
    historyRoundCount: timestamp.optional(),
    productTurnId: id.optional(),
    orderedMessageIds: z.array(id).optional(),
    boundaryMessageId: id.optional(),
    goalBoundary: z
      .object({ kind: z.literal("none") })
      .strict()
      .optional(),
  })
  .strict();
const semantics = z
  .object({
    origin: z.enum(["real_user", "agent_runtime", "system"]),
    kind: z.enum(["user_prompt", "assistant_response", "system_reminder", "compact_summary", "todo_reminder", "fork_notice", "rewind_notice", "timeline_event"]),
    source: z.string().optional(),
    uiVisibility: z.enum(["visible", "hidden"]),
    providerVisibility: z.enum(["visible", "hidden"]),
    transcriptVisibility: z.enum(["visible", "hidden"]),
  })
  .strict();
const forkOrigin=z.object({sessionId:id.optional(),messageId:id.optional(),partId:id.optional(),parentSessionId:id.optional(),targetMessageId:id.optional()}).strict();
const syntheticMetadata = z.object({ source: z.enum(["plugin_reference", "todo_reminder", "fork", "rewind"]), visibility: z.enum(["user-visible", "model-only"]) }).strict();
const userMetadata=z.custom<(z.infer<typeof portableFileMetadata>|z.infer<typeof syntheticMetadata>|Record<never,never>) & {forkOrigin?:z.infer<typeof forkOrigin>}>(value=>{
  if(!value || typeof value!=="object" || Array.isArray(value)) return false;
  const {forkOrigin:origin,...rest}=value as Record<string,unknown>;
  return (origin===undefined || forkOrigin.safeParse(origin).success) &&
    (portableFileMetadata.safeParse(rest).success || syntheticMetadata.safeParse(rest).success || (origin!==undefined && Object.keys(rest).length===0));
});
const commonMessage = { id, agent: id, anchor: anchor.optional(), semantics: semantics.optional() };
const messageInfo = z.discriminatedUnion("role", [
  z
    .object({
      ...commonMessage,
      role: z.literal("user"),
      time: z.object({ created: timestamp }).strict(),
      modelSelection: selection.optional(),
      metadata: userMetadata.optional(),
      synthetic: z.boolean().optional(),
      source: z.enum(["plugin_reference", "todo_reminder", "fork", "rewind"]).optional(),
      visibility: z.enum(["user-visible", "model-only"]).optional(),
      summary: z.object({title:z.string().optional(),body:z.string().optional(),diffs:z.array(z.never())}).strict().optional(),
      system: z.string().optional(),
    })
    .strict(),
  z
    .object({
      ...commonMessage,
      role: z.literal("assistant"),
      parentID: id,
      time: z.object({ created: timestamp, completed: timestamp.optional() }).strict(),
      modelId: id.optional(),
      providerId: id.optional(),
      mode: z.string(),
      planEnabled: z.boolean().optional(),
      cost: z.number().nonnegative(),
      tokens,
      finish: z.enum(["stop", "tool-calls", "length", "cancelled", "error"]).optional(),
      error:z.object({name:id,data:z.object({message:z.string().optional(),code:z.union([z.string(),z.number()]).optional(),statusCode:z.number().optional(),isRetryable:z.boolean().optional()}).strict().optional()}).strict().optional(),
      summary: z.boolean().optional(),
      reasoningLevel: z.string().optional(),
      metadata:z.object({forkOrigin}).strict().optional(),
    })
    .strict(),
]);
const syntheticPartMetadata=z.object({
  source:z.enum(["plugin_reference","todo_reminder","fork","rewind"]).optional(),visibility:z.enum(["user-visible","model-only"]).optional(),
  runtimeMessage:z.object({source:z.enum(["plugin_reference","todo_reminder","conversation_fork","rewind_notice","legacy_synthetic"])}).strict().optional(),
  forkOrigin:forkOrigin.optional(),
}).strict();
const portableFilePart = z
    .object({
      id,
      type: z.literal("file"),
      mime: z.string().min(1).max(256),
      filename: z
        .string()
        .max(255)
        .refine((value) => !/[\\/]/.test(value))
        .optional(),
      url: z.string().refine((value) => conversationArtifactUriSchema.safeParse(value).success),
      metadata: z
        .object({
          storageKind: z.literal("artifact"),
          artifactUri: z
            .string()
            .refine((value) => conversationArtifactUriSchema.safeParse(value).success),
          recoverability: z.literal("provider_ready"),
          sizeBytes: z.number().nonnegative().optional(),
          sha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          image: z
            .object({
              maxDimension: z.number().positive().optional(),
              originalWidth: z.number().positive().optional(),
              originalHeight: z.number().positive().optional(),
              width: z.number().positive().optional(),
              height: z.number().positive().optional(),
              resized: z.boolean().optional(),
              transformedSizeBytes: z.number().nonnegative().optional(),
            })
            .strict()
            .optional(),
        })
        .strict(),
    })
    .strict();
const part = z.discriminatedUnion("type", [
  portableFilePart,
  z
    .object({
      id,
      type: z.literal("text"),
      text: z.string(),
      synthetic: z.boolean().optional(),
      ignored: z.boolean().optional(),
      metadata: syntheticPartMetadata.optional(),
      time: z.object({ start: timestamp, end: timestamp.optional() }).strict().optional(),
    })
    .strict(),
  z.object({ id, type: z.literal("step-start") }).strict(),
  z
    .object({
      id,
      type: z.literal("step-finish"),
      reason: z.enum(["stop", "tool-calls", "length", "cancelled", "error"]),
      cost: z.number().nonnegative(),
      tokens,
    })
    .strict(),
  z.object({id, type:z.literal("tool"),callID:id,tool:id,declarationIndex:timestamp.optional(),metadata:completedToolPartMetadataSchema.strict().optional(),
    state:z.discriminatedUnion("status",[
      z.object({status:z.literal("completed"),input:z.record(z.unknown()),output:z.string(),title:z.string(),
        metadata:completedToolPartMetadataSchema.strict(),attachments:z.array(portableFilePart).optional(),time:z.object({start:timestamp,end:timestamp,compacted:timestamp.optional()}).strict()}).strict(),
      z.object({status:z.literal("error"),input:z.record(z.unknown()),error:z.string(),metadata:completedToolPartMetadataSchema.strict().optional(),time:z.object({start:timestamp,end:timestamp}).strict()}).strict(),
    ])}).strict(),
  z.object({id,type:z.literal("compaction"),auto:z.boolean(),trigger:compactBoundaryPayloadSchema.shape.trigger.optional(),
    phase:compactBoundaryPayloadSchema.shape.phase,compactReason:compactBoundaryPayloadSchema.shape.compactReason,
    tail_start_id:id.optional(),compactBoundary:compactBoundaryPayloadSchema,operationId:id.optional()}).strict(),

  z.object({id,type:z.literal("timeline"),timelineType:z.enum(["session_fork","model_change","context_compaction"]),display:z.enum(["separator","worklog"]),status:z.enum(["completed","failed","interrupted","cancelled"]).optional(),
    anchorMessageId:id.optional(),anchorTurnId:id.optional(),sourceCommandId:id.optional(),originAnchorMessageId:id.optional(),originAnchorTurnId:id.optional(),
    parentSessionId:id.optional(),targetMessageId:id.optional(),targetCheckpointId:id.optional(),restoredFileCount:timestamp.optional(),
    fromModel:selection.optional(),toModel:selection.optional(),operationId:id.optional(),trigger:compactBoundaryPayloadSchema.shape.trigger.optional(),phase:compactBoundaryPayloadSchema.shape.phase,compactReason:compactBoundaryPayloadSchema.shape.compactReason,
    boundaryId:id.optional(),summaryMessageId:id.optional(),preCompactTokenCount:timestamp.optional(),postCompactTokenCount:timestamp.optional(),truePostCompactTokenCount:timestamp.optional(),attempt:timestamp.optional(),maxAttempts:timestamp.optional(),reason:z.string().optional(),
    time:z.object({start:timestamp.optional(),end:timestamp.optional()}).strict().optional()}).strict(),

]);
const input = z
  .object({
    id,
    kind: id,
    delivery: z.enum(["startNow", "guide", "queue"]),
    payload: portableFilePayload,
    admittedSequence: timestamp,
    promotedSequence: timestamp.optional(),
    promotedMessageID: id.optional(),
    status: z.enum(["promoted", "cancelled", "discarded", "failed"]),
    statusReason: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .optional(),
    time: z.object({ created: timestamp, updated: timestamp }).strict(),
  })
  .strict();

/** 静止文本严格子集；不含路径、环境、凭据、权限或任意 metadata。 */
export const textCheckpointSchema = z
  .object({
    format: z.literal("zcode.text-checkpoint"),
    version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    session: z
      .object({
        id: z.custom<string>((value) => conversationSessionIdSchema.safeParse(value).success),
        traceID: id.optional(),
        taskType:z.enum(["interactive","fork"]).optional(),parentID:id.optional(),
        titleSource:z.enum(["default","first_input","generated","custom"]).optional(),titleMessageID:id.optional(),lastOutcome:z.enum(["completed","error","interrupted"]).optional(),lastOutcomeInputId:id.optional(),lastOutcomeAt:timestamp.optional(),
        revert:z.object({messageID:id,partID:id.optional(),kind:z.literal("conversation_rewind"),scope:z.literal("conversation"),targetMessageID:id.optional(),createdMessageID:id.optional(),keptMessageIDs:z.array(id).optional(),branchCutAfterMessageID:id.optional(),branchGeneration:timestamp.optional()}).strict().optional(),
        slug: id,
        title: z.string(),
        version: id,
        time: z.object({ created: timestamp, updated: timestamp }).strict(),
      })
      .strict(),
    modelSelection: selection,
    modelSelectionEntryId: id,
    messages: z.array(z.object({ info: messageInfo, parts: z.array(part).min(1) }).strict()).min(1),
    inputs: z.array(input),
    branchEffects:z.array(z.custom<ConversationEffect>(value=>conversationEffectSchema.safeParse(value).success)).max(1000).optional(),
    execution: z.object({id,time:z.object({created:timestamp,updated:timestamp}).strict(),data:z.object({mode:z.enum(["build","guarded"]),planEnabled:z.boolean()}).strict()}).strict().optional(),
    todos:z.array(z.object({content:z.string(),status:z.enum(["pending","in_progress","completed"]),priority:z.enum(["high","medium","low"]),position:timestamp,created:timestamp,updated:timestamp}).strict()).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const extended = value.session.parentID!==undefined || value.session.revert!==undefined || value.session.titleSource!==undefined || value.session.lastOutcome!==undefined || value.branchEffects !== undefined || value.execution !== undefined || value.todos !== undefined || value.messages.some(m =>
      m.info.summary !== undefined || (m.info.role === "user" && (m.info.synthetic || m.info.source)) ||
      (m.info.role === "assistant" && (m.info.planEnabled || m.info.finish !== "stop")) ||
      m.parts.some(p => p.type === "tool" || p.type === "compaction" || (p.type === "text" && (p.synthetic || p.ignored))));
    if(value.version<4 && (value.messages.length<2 || value.messages.some(message=>message.info.role==="assistant" && (message.info.time.completed===undefined || !message.info.finish || message.info.error)))) context.addIssue({code:"custom",message:"Unsettled legacy message"});
    if (value.version < 4 && extended) context.addIssue({code:"custom",message:"Extended history requires format v4"});
    const refs = checkpointArtifactUris(value);
    if (
      (value.version < 3 && refs.length > 0) ||
      refs.some((uri) => uri.split("/")[2] !== value.session.id)
    )
      context.addIssue({
        code: "custom",
        message: "Registered same-session files require format v3",
      });
    if (
      value.messages.some((message) =>
        message.parts.some(
          (part) => part.type === "file" && part.url !== part.metadata.artifactUri,
        ),
      )
    )
      context.addIssue({ code: "custom", message: "Inconsistent native artifact identity" });
    if (
      value.version === 1 &&
      (value.messages.some(
        (message) => message.info.role === "user" && message.info.metadata !== undefined,
      ) ||
        value.inputs.some(
          (input) =>
            input.payload.conversationInputIntent &&
            "queueItemId" in input.payload.conversationInputIntent,
        ))
    )
      context.addIssue({ code: "custom", message: "V4 input facts require format v2" });
    const seen = new Set<string>();
    const allMessages = new Map(value.messages.map((message) => [message.info.id, message.info]));
    const issue = () =>
      context.addIssue({ code: "custom", message: "Invalid checkpoint identity" });
    const unique = (key: string) => {
      if (seen.has(key)) issue();
      seen.add(key);
    };
    const ref = (key: string | undefined) => {
      if (key && !allMessages.has(key)) issue();
    };
    for (const [index, { info, parts }] of value.messages.entries()) {
      if (info.role === "user" && info.metadata && "conversationInputIntent" in info.metadata) {
        const intent = (info.metadata as z.infer<typeof portableFileMetadata>).conversationInputIntent;
        if (
          parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("") !== intent.text ||
          (info.anchor?.sourceCommandId !== undefined &&
            info.anchor.sourceCommandId !== intent.sourceCommandId)
        )
          issue();
      }
      unique(`message:${info.id}`);
      if (value.version < 4 && info.role !== (index % 2 === 0 ? "user" : "assistant")) issue();
      if (info.role === "assistant" && (value.version < 4 ? info.parentID !== value.messages[index - 1]?.info.id :
        !value.messages.slice(0,index).some(m => m.info.id === info.parentID && m.info.role === "user"))) issue();
      if (value.version < 4 && !parts.some((item) => item.type === "text")) issue();
      for (const part of parts) if (part.type === "compaction") {
        ref(part.tail_start_id);
        ref(part.compactBoundary.lastSummarizedMessageId);
        for (const key of part.compactBoundary.summaryMessageIds) ref(key);
      }
      ref(info.anchor?.boundaryMessageId);
      for (const key of info.anchor?.orderedMessageIds ?? []) ref(key);
      for (const item of parts) {
        unique(`part:${item.id}`);
        if(item.type==="tool" && item.state.status==="completed") {
          const serialized=item.state.metadata.serialization;
          if(serialized?.artifactPath && (serialized.artifactPath!==serialized.artifactUri || !conversationArtifactUriSchema.safeParse(serialized.artifactUri).success)) issue();
          for(const file of item.state.attachments??[]) unique(`part:${file.id}`);
          for(const block of item.state.metadata.modelContentLayout??[]) if(block.type==="attachment" && block.attachmentIndex>=(item.state.attachments?.length??0)) issue();
        }
      }
    }
    const lastReal=value.messages.findLastIndex(message=>message.info.role==="user" && !message.info.synthetic &&
      !message.info.summary && message.info.visibility!=="model-only" && message.info.semantics?.kind!=="compact_summary");
    const realInfo=value.messages[lastReal]?.info;
    let latestInput=realInfo?.anchor?.sourceCommandId ?? (realInfo?.role==="user" && realInfo.metadata && "conversationInputIntent" in realInfo.metadata ? (realInfo.metadata as z.infer<typeof portableFileMetadata>).conversationInputIntent.sourceCommandId : undefined);
    for(const message of value.messages.slice(lastReal)) for(const part of message.parts) {
      if(part.type==="timeline" && part.sourceCommandId) latestInput=part.sourceCommandId;
      if(message.info.anchor?.sourceCommandId) latestInput=message.info.anchor.sourceCommandId;
    }
    if(value.session.lastOutcomeInputId && latestInput && value.session.lastOutcomeInputId!==latestInput) issue();
    const terminalFailed=value.session.lastOutcomeInputId===latestInput && latestInput!==undefined && value.session.lastOutcomeAt!==undefined && ["error","interrupted"].includes(value.session.lastOutcome??"");
    if(value.version===4 && lastReal>=0 && !terminalFailed && !value.messages.slice(lastReal+1).some(message=>message.info.role==="assistant" && (message.info.error || ["stop","length","error","cancelled"].includes(message.info.finish??"")))) issue();

    ref(value.session.titleMessageID);
    if(value.session.revert) {const revert=value.session.revert;ref(revert.messageID);ref(revert.targetMessageID);ref(revert.createdMessageID);ref(revert.branchCutAfterMessageID);for(const key of revert.keptMessageIDs??[]) ref(key);}
    for (const item of value.inputs) {
      const intent = item.payload.conversationInputIntent;
      // Ledger admittedSequence and V4 admissionSeq are different native sequences.
      // Preserve both; terminal status, not the old intent dispatch hint, prevents replay.
      if (
        intent &&
        "queueItemId" in intent &&
        (intent.text !== item.payload.text || intent.queueItemId !== item.id)
      )
        issue();
      unique(`input:${item.id}`);
      ref(item.promotedMessageID);
      unique(`admission:${item.admittedSequence}`);
      if (item.status === "promoted") {
        if (
          !item.promotedMessageID ||
          allMessages.get(item.promotedMessageID)?.role !== "user" ||
          item.promotedSequence === undefined
        )
          issue();
      } else if (item.promotedMessageID !== undefined || item.promotedSequence !== undefined)
        issue();
    }
    if (value.messages[0]?.info.role !== "user" || (value.version < 4 && value.messages.at(-1)?.info.role !== "assistant"))
      issue();
  });

export type TextCheckpoint = z.infer<typeof textCheckpointSchema>;
export function checkpointArtifactUris(value: {
  messages: Array<{
    info: {
      role: string;
      metadata?: unknown;
    };
    parts: Array<{ type: string; url?: string;state?:{status:string;attachments?:Array<{url:string}>;metadata?:{serialization?:{artifactUri?:string;artifactPath?:string}}} }>;
  }>;
  inputs: Array<{
    payload: {
      conversationInputIntent?: {
        sourceCommandId: string;
        attachments?: Array<{ ref: string; previewRef?: string }>;
      };
      attachments?: Array<{ ref: string; previewRef?: string }>;
    };
  }>;
}) {
  const refs = new Set<string>();
  const add = (items: Array<{ ref: string; previewRef?: string }> | undefined) => {
    for (const item of items ?? []) {
      refs.add(item.ref);
      if (item.previewRef) refs.add(item.previewRef);
    }
  };
  for (const message of value.messages) {
    for (const part of message.parts) {
      if (part.type === "file" && part.url) refs.add(part.url);
      if(part.type==="tool" && part.state?.status==="completed") {
        for(const file of part.state.attachments??[]) refs.add(file.url);
        const uri=part.state.metadata?.serialization?.artifactUri;
        if(uri) refs.add(uri);
      }
    }
    const metadata = message.info.metadata;
    if (metadata && typeof metadata === "object" && "conversationInputIntent" in metadata) {
      const intent = portableFileIntent.safeParse(metadata.conversationInputIntent);
      if (intent.success) add(intent.data.attachments);
    }
  }
  for (const item of value.inputs) {
    add(item.payload.attachments);
    add(item.payload.conversationInputIntent?.attachments);
  }
  return [...refs].sort();
}
/** Observations from native tool facts, not semantic parsing of model prose. */
export function checkpointEffectReferences(value:TextCheckpoint):ConversationEffect[] {
  const effects:ConversationEffect[]=[...(value.branchEffects??[])];
  for(const message of value.messages) for(const part of message.parts) {
    if(part.type!=="tool") continue;
    const metadata=part.state.metadata??part.metadata;
    if(metadata?.businessEffect) {effects.push(conversationEffectSchema.parse(metadata.businessEffect));continue;}
    const display=metadata?.display;
    if(metadata?.readOnly!==true && (metadata?.sideEffectScope==="network" || metadata?.sideEffectScope==="system" || part.tool==="Bash") && (!display || display.kind!=="mcp_tool")) {
      effects.push({server:"native:"+part.tool,owner:"native:"+part.tool,operation:part.callID,requestKey:"unknown",receiptUri:"mcp-effect://unconfirmed",outcome:"unknown"});continue;
    }
    if(metadata?.mcpReadOnly===true || !display || display.kind!=="mcp_tool") continue;
    effects.push({server:display.serverName,owner:display.serverName,operation:part.callID,requestKey:"unknown",receiptUri:"mcp-effect://unconfirmed",outcome:"unknown"});
  }
  const unique=new Map<string,ConversationEffect>();
  for(const effect of effects) {
    const key=JSON.stringify([effect.server,effect.owner,effect.operation,effect.requestKey]);
    const prior=unique.get(key);
    if(prior && JSON.stringify(prior)!==JSON.stringify(effect)) throw new TextCheckpointError("unsupported_state");
    unique.set(key,effect);
  }
  return [...unique.values()];
}
export type TextCheckpointErrorCode =
  | "invalid_checkpoint"
  | "unsupported_state"
  | "identity_conflict"
  | "session_not_found"
  | "storage_failure";
export class TextCheckpointError extends Error {
  constructor(
    readonly code: TextCheckpointErrorCode,
    options?: ErrorOptions,
  ) {
    super(`Text checkpoint: ${code}`, options);
    this.name = "TextCheckpointError";
  }
}
export interface TextCheckpointStorePort {
  /** 调用方必须已关闭接纳并收口；一致读不证明 runtime 已静止。 */
  exportTextCheckpoint(input: { sessionID: SessionId }): Promise<TextCheckpoint>;
  /** 原子 create-only；不授权、不执行、不覆盖现有身份。 */
  importTextCheckpoint(input: {
    checkpoint: unknown;
    target: { projectID: ProjectId; workspaceID?: WorkspaceId; directory: string };
  }): Promise<void>;
}
