import { getZCodeUserVisibleMessages } from "./zcode-session-visible-content.js";
import type { ZCodeSessionStateSnapshot } from "./zcode-protocol/index.js";
import type { ZCodeMessagePart, ZCodeMessageWithParts } from "./zcode-protocol-legacy-types.js";
const TASK_SEARCH_TEXT_MAX_CHARS = 200_000;
/** Same native search projection for live snapshots and cold checkpoints. */
export function buildZCodeTaskSearchText(snapshot: {
  messages: readonly ZCodeMessageWithParts[];
  projection: Pick<ZCodeSessionStateSnapshot["projection"], "target">;
}): string {
  const parts: string[] = [];
  let total = 0;
  // /goal 自动续跑会把内部 system-reminder 作为 runtime user turn 持久化；
  // 这条内容是 model-only 输入，不是用户可见 query，不能写进侧边栏搜索正文。
  for (const message of getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  })) {
    const textParts = message.parts.filter(
      (part): part is Extract<ZCodeMessagePart, { type: "text" }> => part.type === "text",
    );
    if (textParts.length === 0) {
      continue;
    }
    const chosen = message.info.role === "assistant" ? textParts.slice(-1) : textParts;
    for (const part of chosen) {
      const content = part.text.trim();
      if (!content) {
        continue;
      }
      parts.push(content);
      total += content.length;
      if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
        break;
      }
    }
    if (total >= TASK_SEARCH_TEXT_MAX_CHARS) {
      break;
    }
  }
  // 关键业务逻辑：上限截断，避免长任务把 tasks-index.sqlite 放大到影响启动和列表查询。
  return parts.join("\n").slice(0, TASK_SEARCH_TEXT_MAX_CHARS);
}
