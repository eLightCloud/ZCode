import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { ConversationSaveIndicator } from "./ConversationSaveIndicator.js";
import type { ConversationHistoryLabels } from "../components/ConversationHistory.js";
import type { useConversationHistory } from "../hooks/useConversationHistory.js";

/** Read projection of unattached saved sessions in the native task section; no fake cwd/meta. */
export function ConversationSidebar({
  history,
  labels,
  nativeSessionIds,
  onOpen,
  activeSession,
}: {
  history: ReturnType<typeof useConversationHistory>;
  labels: ConversationHistoryLabels;
  activeSession?: string;
  nativeSessionIds: readonly string[];
  onOpen(session: string, version: string): void;
}) {
  const [showInactive, setShowInactive] = useState(false);
  const native = new Set(nativeSessionIds);
  const additional = history.items.filter((item) => !native.has(item.session));
  const items = additional.filter(
    (item) => showInactive || (!item.management?.archived && !item.management?.deleted),
  );
  const hasInactive = additional.some(
    (item) => item.management?.archived || item.management?.deleted,
  );
  return (
    <div data-testid="saved-conversation-rows" className="pr-2">
      {history.loading && !history.items.length && (
        <p role="status" className="px-2.5 py-2 text-ui-caption text-foreground-subtle">
          {labels.loading}
        </p>
      )}
      {history.failed && (
        // 侧栏仅保留失败摘要和原位刷新，避免诊断长文挤占任务导航。
        <div className="flex min-w-0 items-center gap-2 px-2.5 py-1 text-ui-caption text-foreground-subtle">
          <span role="alert" className="min-w-0 truncate">
            {labels.sidebarUnavailable ?? labels.unavailable}
          </span>
          <Button
            variant="link"
            size="sm"
            className="h-auto px-0 py-1 text-ui-caption focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11 max-sm:min-w-11"
            onClick={() => void history.refresh()}
          >
            {labels.refresh}
          </Button>
        </div>
      )}
      {!history.loading && !history.failed && !items.length && !nativeSessionIds.length && (
        <p className="px-2.5 py-2 text-ui-caption text-foreground-subtle">{labels.empty}</p>
      )}
      <ul className="space-y-0.5">
        {items.map((item) => {
          const version = item.version ?? item.candidates[0];
          return (
            <li key={item.session}>
              <button
                type="button"
                aria-current={item.session === activeSession ? "page" : undefined}
                disabled={!version}
                className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1 text-left text-ui-base hover:bg-surface-hover aria-[current=page]:bg-selected focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11"
                onClick={() => version && onOpen(item.session, version)}
              >
                <span aria-hidden="true" className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{item.title || item.session}</span>
                {item.management?.deleted || item.management?.archived ? (
                  <span className="text-ui-caption text-foreground-subtle">
                    {item.management.deleted ? labels.deleted : labels.archived}
                  </span>
                ) : (
                  <ConversationSaveIndicator
                    conflict={item.candidates.length > 1}
                    label={item.candidates.length > 1 ? labels.conflict : labels.saved}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {hasInactive && (
        <Button
          variant="ghost"
          className="w-full"
          aria-expanded={showInactive}
          onClick={() => setShowInactive(!showInactive)}
        >
          {showInactive ? labels.hideInactive : labels.showInactive}
        </Button>
      )}
      {history.hasMore && (
        <Button
          variant="ghost"
          className="w-full"
          disabled={history.loading}
          onClick={() => void history.more()}
        >
          {labels.more}
        </Button>
      )}
    </div>
  );
}
