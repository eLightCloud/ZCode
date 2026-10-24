import type { SessionId, SessionStorePort } from "@zcode/contracts";
import { conversationEffectSchema, type ConversationEffect } from "@zcode/shared";

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
    if (!Array.isArray(value)) throw new Error("branch_effect_context_invalid");
    return value.map((effect) => conversationEffectSchema.parse(effect));
  });
}
