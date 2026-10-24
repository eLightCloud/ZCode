import type { SessionId, SessionStorePort } from "@zcode/contracts";
import { conversationEffectSchema, type ConversationEffect } from "@zcode/shared";

/** A reconciliation failure proves that the proposed write has not started. */
export class BranchEffectCheckError extends Error {
  constructor(
    readonly code:
      | "branch_effect_context_invalid"
      | "branch_effect_verification_required"
      | "branch_effect_result_unknown",
  ) {
    super(code);
    this.name = "BranchEffectCheckError";
  }
}

/** Native imported references are observations; only the resource owner can settle an action. */
export async function readBranchEffects(
  store: SessionStorePort | undefined,
  sessionId: string,
): Promise<ConversationEffect[]> {
  if (!store?.sessionEntries) return [];
  const entries = await store.sessionEntries({
    sessionID: sessionId as SessionId,
    type: "runtime/branch_effects",
  });
  return entries.flatMap(({ data }) => {
    const value = data && typeof data === "object" && "effects" in data ? data.effects : data;
    // 损坏的已导入上下文不能按空效果处理后放行业务写入。
    if (!Array.isArray(value)) throw new BranchEffectCheckError("branch_effect_context_invalid");
    return value.map((effect) => {
      const parsed = conversationEffectSchema.safeParse(effect);
      if (!parsed.success) throw new BranchEffectCheckError("branch_effect_context_invalid");
      return parsed.data;
    });
  });
}
