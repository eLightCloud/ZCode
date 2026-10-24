import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ConversationHistory,
  type ConversationHistoryLabels,
  type ConversationHistoryReader,
} from "../../src/conversation-workbench/contract.js";
it("renders injected labels without invoking a reader or creating an execution path", () => {
  const history = vi.fn(async () => []),
    transcript = vi.fn(async () => null);
  const reader: ConversationHistoryReader = { history, transcript };
  const labels: ConversationHistoryLabels = {
    title: "Vantage owned history",
    workspace: "Workspace",
    refresh: "Refresh",
    loading: "Loading",
    unavailable: "Unavailable",
    empty: "Empty",
    saved: "Saved",
    continuationUnavailable: "Unavailable",
    archived: "Archived",
    deleted: "Deleted",
    unknownIndex: "Unknown",
    conflict: "Conflict",
    more: "More",
    choose: "Choose",
    user: "User",
    assistant: "Assistant",
  };
  const html = renderToStaticMarkup(
    createElement(ConversationHistory, { reader, labels, onWorkspace: vi.fn() }),
  );
  expect(html).toContain("Vantage owned history");
  expect(history).not.toHaveBeenCalled();
  expect(transcript).not.toHaveBeenCalled();
});
