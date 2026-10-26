import type { ComponentProps } from "react";
import type { Root } from "@zcode/ui";

export async function openApplicationConversation(
  target: Parameters<
    NonNullable<ComponentProps<typeof Root>["applicationConversationNavigation"]>
  >[0],
) {
  const path =
    "/workspace?" +
    new URLSearchParams({ instance_id: target.instanceId, conversation: target.session });
  if (target.draft) {
    if (!target.scope) throw new Error("conversation_scope_unconfirmed");
    const response = await fetch("/api/native/conversations/identity", {
      cache: "no-store",
      credentials: "same-origin",
    });
    const identity = response.ok ? await response.json() : null;
    if (!identity || identity.tenant + ":" + identity.subject !== target.scope)
      throw new Error("conversation_scope_changed");
    // 未接纳输入只作本次同主体导航的草稿交接，不进 URL、日志或执行队列。
    window.history.pushState({ zcodeConversationDraft: { ...target } }, "", path);
    window.location.reload();
  } else window.location.assign(path);
}
