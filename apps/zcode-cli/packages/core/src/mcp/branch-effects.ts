import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { McpPort, McpToolCallResult, McpToolDescriptor } from "@zcode/contracts";
import { conversationEffectSchema, type ConversationEffect } from "@zcode/shared";
import type { ToolExecutionContext } from "../tool/types.js";
import { readBranchEffects } from "../tool/branch-effects.js";

const resultSchema = z
  .object({
    content: z.array(z.record(z.string(), z.unknown())),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
    _meta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const decisionSchema = z
  .object({
    action: z.object({ tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).strict(),
    decision: z.enum(["proceed", "replay", "unknown", "blocked", "requires_confirmation"]),
    result: resultSchema.optional(),
  })
  .strict();

/** One resource request, with the same identity/trace/workspace as the proposed action. */
export async function reconcileBranchEffects(options: {
  descriptor: McpToolDescriptor;
  readOnly: boolean;
  arguments: Record<string, unknown>;
  port: McpPort;
  context: ToolExecutionContext;
  timeoutMs: number;
}): Promise<McpToolCallResult | undefined> {
  const { descriptor, readOnly, port, context, timeoutMs } = options;
  if (readOnly) return;
  const effects = (await readBranchEffects(context.sessionStore, context.sessionId)).filter(
    (effect) => effect.server === descriptor.serverName,
  );
  if (!effects.length) return;
  const checker =
    descriptor.effectCheckTool &&
    (await port.listTools()).find(
      (tool) =>
        tool.serverName === descriptor.serverName &&
        tool.toolName === descriptor.effectCheckTool &&
        tool.annotations?.readOnlyHint === true,
    );
  if (!checker) throw new Error("branch_effect_verification_required");
  const action = { tool: descriptor.toolName, arguments: options.arguments };
  const checked = await port.callTool(
    {
      serverName: descriptor.serverName,
      toolName: checker.toolName,
      arguments: { effects, action },
      trace: { traceId: context.traceId, sessionId: context.sessionId, turnId: context.turnId },
      runtimeScope: context.runtimeScope ?? "main",
      workspacePath: context.workingDirectory,
      workspaceKey: context.workspaceIdentity?.trim() || context.workingDirectory,
      ...(context.workspaceIdentity?.trim()
        ? { workspaceIdentity: context.workspaceIdentity.trim() }
        : {}),
      ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
      clientMode: context.clientMode ?? "desktop-continuous",
      deliveryKind: context.deliveryKind ?? "desktop-continuous",
      ...(context.turnId ? { turnId: context.turnId } : {}),
    },
    { signal: context.abortSignal, timeoutMs },
  );
  const parsed = decisionSchema.safeParse(checked.structuredContent);
  if (checked.isError || !parsed.success || !isDeepStrictEqual(parsed.data.action, action))
    throw new Error("branch_effect_result_unknown");
  const decision = parsed.data;
  if (decision.decision === "proceed") return;
  if (decision.decision !== "replay") throw new Error("branch_effect_verification_required");
  const original = decision.result;
  const receipt = conversationEffectSchema.safeParse(original?._meta?.["zcode/effect"]);
  if (
    !original ||
    original.isError ||
    !receipt.success ||
    receipt.data.outcome === "unknown" ||
    receipt.data.server !== descriptor.serverName ||
    !effects.some((effect) => sameOperation(effect, receipt.data))
  )
    throw new Error("branch_effect_result_unknown");
  return {
    ...original,
    _meta: { ...original._meta, "zcode/readOnly": readOnly, "zcode/effect": receipt.data },
  };
}

function sameOperation(a: ConversationEffect, b: ConversationEffect): boolean {
  return (
    a.server === b.server &&
    a.owner === b.owner &&
    a.operation === b.operation &&
    a.requestKey === b.requestKey
  );
}
