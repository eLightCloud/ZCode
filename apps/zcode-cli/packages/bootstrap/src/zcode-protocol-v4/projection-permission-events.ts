import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";

// ProductProjection —— CLI 权威投影第二 reducer。
// 输入：CLI 事件日志（SessionEvent，权威事实源）；输出：ConversationDelta[]。
// 快照推进复用协议规范 apply（applyConversationDeltas）——投影演进与 delta 流
// 逐字节一致是构造保证，黄金测试再用独立重放交叉验证。
//
// 覆盖：session/turn 生命周期、流式文本/思考、tool call 状态机、
// 权限交互、turn-steer 队列、usage、错误态、迟到终态拒收、
// compact marker、goal 状态机、fork marker。传输外壳（TopicFrame/subscribe）在后续片。
import type {
  PermissionDeniedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  SessionEvent,
  UserInputAutoResolutionUpdatedPayload,
} from "@zcode/contracts";

import { AMEND_WORKFLOW_TOOL_NAME, CREATE_WORKFLOW_TOOL_NAME } from "@zcode/contracts";

// review 单调性裁决单一来源；projection 只实现“应用策略”（advance/no_current 接受，
// 其余忽略；跨 flow 等 onSessionResumed 清空）。
// （改直连 monotonicity subpath；discovery barrel 的该 re-export
// 会在 packages/ui 的 Desktop 构建链解析失败，App 重启后打不开。）
import { WORKFLOW_REFINE_PERMISSION_OPTION_ID } from "@zcode/shared";

import type {
  ConversationDelta,
  PendingInteraction,
  ToolCallRow,
} from "@zcode/shared/zcode-protocol-v4";

import {
  SESSION_ALLOW_PERMISSION_OPTION_KIND,
  buildProtocolPermissionOptions,
} from "../permission-options.js";

import {
  MCP_ELICITATION_INTERACTION,
  MCP_ELICITATION_TOOL_NAME,
  mcpElicitationQuestions,
} from "./mcp-elicitation.js";

import {
  createExitPlanModeApprovalQuestion,
  isAskUserQuestionToolName,
  isExitPlanModeToolName,
  isPlainRecord,
  readAskUserQuestionPayloadQuestions,
  toProtocolToolCallDisplay,
} from "./product-projection-tool-display.js";
import type { ProductProjectionContext } from "./projection-context.js";
// ── 权限交互（阻塞交互 → 状态）──

export function onPermissionRequested(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionRequestedPayload;
  const toolCallId = String(payload.toolCallId);
  const interactionId = payload.requestId ?? `perm-${toolCallId}`;
  const interaction = this.createPendingInteractionFromPermissionEvent(
    event,
    payload,
    toolCallId,
    interactionId,
  );
  const deltas: ConversationDelta[] = [];
  const row = this.findToolRow(toolCallId);
  if (row) {
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        status: "pendingApproval",
        approvalInteractionId: interactionId,
      },
    });
  }
  deltas.push({
    op: "state.updated",
    patch: {
      pendingInteractions: [...this.snapshot.pendingInteractions, interaction],
    },
  });
  return deltas;
}

export function createPendingInteractionFromPermissionEvent(
  this: ProductProjectionContext,
  event: SessionEvent,
  payload: PermissionRequestedPayload,
  toolCallId: string,
  interactionId: string,
): PendingInteraction {
  if (isAskUserQuestionToolName(payload.toolName)) {
    // AskUserQuestion 的 permission_requested 只是 runtime 等待态；
    // v4 UI 需要结构化 questions 才能回填 answers，而不是 Allow/Deny 权限弹窗。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: this.ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { toolName: payload.toolName },
        questions: readAskUserQuestionPayloadQuestions(payload.input),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (payload.toolName === MCP_ELICITATION_TOOL_NAME) {
    // MCP elicitation：requestedSchema → 结构化问题，
    // 与 broker 用同一映射，v4 UI 复用 ElicitationDialog。
    const elicitation = isPlainRecord(payload.input) ? payload.input : {};
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: this.ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: {
          interaction: MCP_ELICITATION_INTERACTION,
          serverName: elicitation.serverName,
          requestedSchema: elicitation.requestedSchema,
        },
        questions: mcpElicitationQuestions(payload.reason, elicitation.requestedSchema),
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  if (isExitPlanModeToolName(payload.toolName)) {
    // ExitPlanMode 复用 userInput/elicitation 通道承载计划审批反馈；
    // 普通 permission payload 无法表达 approve/custom feedback 的业务语义。
    return {
      interactionId,
      kind: "userInput",
      anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
      createdAt: this.ms(event),
      payload: {
        kind: "userInput",
        prompt: payload.reason,
        freeText: true,
        toolCallId,
        toolName: payload.toolName,
        traceId: event.traceId,
        input: payload.input,
        schema: { interaction: "plan_approval", toolName: payload.toolName },
        questions: [createExitPlanModeApprovalQuestion(payload.reason)],
        ...(payload.origin ? { origin: payload.origin } : {}),
      },
    };
  }
  const askDisplay = toProtocolToolCallDisplay(payload.display);
  return {
    interactionId,
    kind: "permission",
    anchorRowId: this.toolRowIdByCallId.get(toolCallId) ?? null,
    createdAt: this.ms(event),
    payload: {
      kind: "permission",
      toolCallId,
      toolName: payload.toolName,
      summary: payload.reason,
      detail: payload.input,
      freeText: true,
      ...(payload.approvalMode !== "user-once" &&
      payload.fullAccessSupported === true &&
      !payload.origin &&
      !payload.optionsPolicy
        ? {
            fullAccessOption: {
              optionId: PERMISSION_FULL_ACCESS_OPTION_ID,
              label: "Full access",
              kind: "custom" as const,
              response: { decision: "deny" as const, reason: "Full access requires V4 approval" },
            },
          }
        : {}),
      ...(payload.origin ? { origin: payload.origin } : {}),
      ...(askDisplay ? { display: askDisplay } : {}),
      options: [
        ...buildProtocolPermissionOptions({
          approvalMode: payload.approvalMode,
          input: payload.input,
          suggestedPermissionUpdates: payload.suggestedPermissionUpdates,
          ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
          toolName: payload.toolName,
        }).map((option) => ({
          optionId:
            option.kind === "allow_once"
              ? "allowOnce"
              : option.kind === "allow_always"
                ? "allowAlways"
                : option.optionId,
          label: option.name,
          // 会话免确认的 kind 映到闭集里的 allowAlways（排序槽位 / 样式与 always allow 同），
          // optionId 原样 allowSession——broker 靠它精确命中，GUI 靠 name 本地化。
          kind:
            option.kind === "allow_once"
              ? ("allowOnce" as const)
              : option.kind === "allow_always" ||
                  option.kind === SESSION_ALLOW_PERMISSION_OPTION_KIND
                ? ("allowAlways" as const)
                : ("deny" as const),
          response: option.response,
        })),
        // workflow Refine 只在 v4 投放（legacy 选项列表刻意不含，见 session-mapper 注释）。
        // 静态 response 是普通 deny：任何不认识该
        // optionId 的消费面（无 freeText 的应答）都退化为拒绝，反馈升级只发生在
        // interaction-broker 对 freeText 的特判里。
        ...(payload.toolName === CREATE_WORKFLOW_TOOL_NAME ||
        payload.toolName === AMEND_WORKFLOW_TOOL_NAME
          ? [
              {
                optionId: WORKFLOW_REFINE_PERMISSION_OPTION_ID,
                label: "Refine",
                kind: "custom" as const,
                response: { decision: "deny" as const, reason: "Denied" },
              },
            ]
          : []),
      ],
    },
  };
}

export function onPermissionResolved(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionResolvedPayload;
  return this.settlePermission(
    String(payload.toolCallId),
    payload.decision === "deny" ? "cancelled" : "running",
  );
}

export function onPermissionDenied(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as PermissionDeniedPayload;
  return this.settlePermission(String(payload.toolCallId), "cancelled");
}

export function onUserInputAutoResolutionUpdated(
  this: ProductProjectionContext,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as UserInputAutoResolutionUpdatedPayload;
  let changed = false;
  const pendingInteractions = this.snapshot.pendingInteractions.map((interaction) => {
    if (
      interaction.interactionId !== payload.interactionId ||
      interaction.payload.kind !== "userInput"
    ) {
      return interaction;
    }
    changed = true;
    return {
      ...interaction,
      autoResolution: payload.autoResolution,
    };
  });
  return changed ? [{ op: "state.updated", patch: { pendingInteractions } }] : [];
}

export function settlePermission(
  this: ProductProjectionContext,
  toolCallId: string,
  status: ToolCallRow["status"],
): ConversationDelta[] {
  const deltas: ConversationDelta[] = [];
  const row = this.findToolRow(toolCallId);
  if (row) {
    const next: ToolCallRow = { ...row, status };
    delete next.approvalInteractionId;
    deltas.push({ op: "row.upserted", row: next });
  }
  const remaining = this.snapshot.pendingInteractions.filter(
    (item) =>
      !(
        (item.payload.kind === "permission" || item.payload.kind === "userInput") &&
        item.payload.toolCallId === toolCallId
      ),
  );
  if (remaining.length !== this.snapshot.pendingInteractions.length) {
    deltas.push({
      op: "state.updated",
      patch: { pendingInteractions: remaining },
    });
  }
  return deltas;
}
