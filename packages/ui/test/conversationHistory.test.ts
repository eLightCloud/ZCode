// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ConversationHistory,
  type ConversationHistoryLabels,
} from "../src/components/ConversationHistory.js";
import type { ConversationHistoryReader } from "@zcode/shared";
const labels: ConversationHistoryLabels = {
  title: "History",
  workspace: "Open workspace",
  refresh: "Refresh",
  loading: "Loading",
  unavailable: "Unavailable",
  empty: "Empty",
  saved: "Server saved",
  continuationUnavailable: "Continuation unavailable",
  archived: "Archived",
  deleted: "Deleted",
  unknownIndex: "Unknown management",
  conflict: "Conflict",
  more: "More",
  choose: "View version",
  user: "User",
  assistant: "Assistant",
};
afterEach(cleanup);
it("reads saved candidates without an execution service and never renders text as executable HTML", async () => {
  const onWorkspace = vi.fn();
  const reader: ConversationHistoryReader = {
    history: vi.fn(async () => [
      {
        session: "s",
        version: "v",
        title: "User title",
        management: null,
        candidates: ["v", "other"],
        selected: null,
        revision: 1,
      },
    ]),
    transcript: vi.fn(async () => ({
      session: "s",
      version: "v",
      title: "User title",
      deleted: false,
      messages: [{ id: "m", role: "assistant", text: "<script>private</script>" }],
    })),
  };
  render(createElement(ConversationHistory, { reader, labels, onWorkspace }));
  await screen.findByText("User title");
  expect(screen.getByText(/Server saved/).textContent).toContain("Unknown management");
  expect(onWorkspace).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "View version 1" }));
  await screen.findByText("<script>private</script>");
  expect(document.querySelector("script")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
  expect(onWorkspace).toHaveBeenCalledOnce();
});
it("clears cached body on a new identity failure and ignores old responses after refresh", async () => {
  let late!: (value: unknown) => void;
  const reader = {
    history: vi.fn(async () => []),
    transcript: vi.fn(
      () =>
        new Promise((resolve) => {
          late = resolve;
        }),
    ),
  };
  reader.history.mockResolvedValueOnce([
    {
      session: "s",
      version: "v",
      title: "Previous account",
      management: null,
      candidates: ["v"],
      selected: null,
      revision: 1,
    },
  ] as never);
  render(
    createElement(ConversationHistory, {
      reader: reader as ConversationHistoryReader,
      labels,
      onWorkspace: vi.fn(),
    }),
  );
  await screen.findByText("Previous account");
  fireEvent.click(screen.getByRole("button", { name: "View version 1" }));
  reader.history.mockRejectedValueOnce(new Error("revoked"));
  fireEvent.focus(window);
  await screen.findByRole("alert");
  late({ session: "s", version: "v", title: "Leaked", deleted: false, messages: [] });
  await waitFor(() => expect(screen.queryByText("Previous account")).toBeNull());
  expect(screen.queryByText("Leaked")).toBeNull();
});
