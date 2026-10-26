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

const deletionLabels = {
  ...labels,
  deletionChoice: {
    action: "Choose deletion",
    warning: "Other copies and business effects remain.",
    confirm: "Confirm choice",
    cancel: "Cancel",
    retry: "Check original choice",
    succeeded: "Deletion confirmed",
    stale: "Refresh changed candidates",
    blocked: "Choice blocked",
    unavailable: "Choice unconfirmed",
  },
};
function deletionReader() {
  return {
    history: vi.fn(async () => [
      {
        session: "s",
        version: "deleted",
        title: "Deleted candidate",
        management: { titleOverride: null, archived: false, deleted: true, pinned: false },
        candidates: ["deleted", "edit"],
        selected: null,
        revision: 4,
      },
    ]),
    transcript: vi.fn(async () => ({
      session: "s",
      version: "deleted",
      title: "Deleted candidate",
      deleted: true,
      messages: [],
    })),
    chooseDeletion: vi.fn<NonNullable<ConversationHistoryReader["chooseDeletion"]>>(async () => {}),
  };
}
it("viewing and cancelling a deletion confirmation never submits a choice", async () => {
  const reader = deletionReader();
  render(
    createElement(ConversationHistory, { reader, labels: deletionLabels, onWorkspace: vi.fn() }),
  );
  await screen.findByText("Deleted candidate");
  fireEvent.click(screen.getByRole("button", { name: "View version 1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Choose deletion" }));
  expect(reader.chooseDeletion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(reader.chooseDeletion).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Choose deletion" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm choice" }));
  await screen.findByText("Deletion confirmed");
  expect(reader.chooseDeletion).toHaveBeenCalledWith(
    expect.objectContaining({
      session: "s",
      version: "deleted",
      candidates: ["deleted", "edit"],
      revision: 4,
    }),
    expect.any(AbortSignal),
  );
});
it("an unconfirmed choice explicitly retries the same operation and stale candidates require refresh", async () => {
  const { ConversationChoiceError } = await import("@zcode/shared");
  const reader = deletionReader();
  reader.chooseDeletion.mockRejectedValueOnce(new Error("transport lost ACK"));
  render(
    createElement(ConversationHistory, { reader, labels: deletionLabels, onWorkspace: vi.fn() }),
  );
  await screen.findByText("Deleted candidate");
  fireEvent.click(screen.getByRole("button", { name: "View version 1" }));
  fireEvent.click(await screen.findByRole("button", { name: "Choose deletion" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm choice" }));
  await screen.findByText("Choice unconfirmed");
  const first = reader.chooseDeletion.mock.calls[0]?.[0];
  reader.chooseDeletion.mockRejectedValueOnce(new ConversationChoiceError("stale"));
  fireEvent.click(screen.getByRole("button", { name: "Check original choice" }));
  await screen.findByText("Refresh changed candidates");
  expect(reader.chooseDeletion.mock.calls[1]?.[0]).toEqual(first);
  expect(screen.queryByRole("button", { name: "Check original choice" })).toBeNull();
});

it("shows a trusted failure message and clears it after a successful retry", async () => {
  const error = new Error("private upstream details");
  const reader: ConversationHistoryReader = {
    history: vi.fn().mockRejectedValueOnce(error).mockResolvedValue([]),
    transcript: vi.fn(),
  };
  render(
    createElement(ConversationHistory, {
      reader,
      labels: {
        ...labels,
        readError: (failure) => (failure === error ? "History service unavailable" : "Unexpected"),
      },
      onWorkspace: vi.fn(),
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toBe("History service unavailable");
  expect(screen.queryByText("private upstream details")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Empty");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText(labels.continuationUnavailable)).toBeNull();
});
