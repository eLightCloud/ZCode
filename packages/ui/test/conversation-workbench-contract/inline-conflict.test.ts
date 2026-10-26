// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ConversationConflict,
  useConversationHistory,
  type ConversationHistoryReader,
} from "../../src/conversation-workbench/contract.js";
afterEach(cleanup);
function fixture(changed = false) {
  const run = vi.fn(async (input) => ({
    session: "s",
    operation: input.operation,
    status: "ready" as const,
    phase: "ready" as const,
    location: "desktop",
    version: input.version,
  }));
  const prepareTarget = vi.fn();
  const reader: ConversationHistoryReader = {
    history: vi.fn(async () => [
      {
        session: "s",
        version: "v",
        title: "Task",
        management: null,
        candidates: ["v", "other"],
        selected: "v",
        revision: 1,
      },
    ]),
    transcript: vi.fn(async (_session, version) => ({
      session: "s",
      version,
      title: "Task",
      deleted: false,
      messages: [
        { id: "m", role: "assistant", text: version === "v" ? "Local update" : "Server update" },
      ],
    })),
    continuation: {
      options: vi.fn(async () => ({
        session: "s",
        revision: 1,
        candidates: changed ? ["v", "other", "new"] : ["v", "other"],
        active: { location: "desktop", version: "v", generation: 1 },
        pending: null,
        handoff: null,
        inflight: null,
        targets: [{ location: "desktop", label: "Desktop" }],
      })),
      run,
      prepareTarget,
      cancel: vi.fn(),
    },
  };
  return { reader, run, prepareTarget };
}
function Harness({ reader, done }: { reader: ConversationHistoryReader; done(): void }) {
  const history = useConversationHistory(reader);
  return createElement(ConversationConflict, {
    reader,
    history,
    session: "s",
    chinese: true,
    getLocation: async () => "desktop",
    onResolved: done,
  });
}
it("asks about actual content in-place and uses the existing native selection only after choice", async () => {
  const f = fixture(),
    done = vi.fn();
  render(createElement(Harness, { reader: f.reader, done }));
  await screen.findByText("Local update");
  await screen.findByText("Server update");
  expect(f.run).not.toHaveBeenCalled();
  expect(f.reader.continuation?.options).not.toHaveBeenCalled();
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "使用这份内容" })[0]);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(f.run.mock.calls[0][0]).toMatchObject({
    session: "s",
    kind: "select",
    target: "desktop",
    version: "v",
    candidates: ["v", "other"],
    revision: 1,
  });
  expect(f.prepareTarget).not.toHaveBeenCalled();
});
it("does not silently select when the server has a new candidate", async () => {
  const f = fixture(true);
  render(createElement(Harness, { reader: f.reader, done: vi.fn() }));
  await screen.findByText("Local update");
  fireEvent.click(screen.getAllByRole("button", { name: "使用这份内容" })[0]);
  await screen.findByRole("button", { name: "查看最新内容" });
  expect(f.run).not.toHaveBeenCalled();
  expect(f.prepareTarget).not.toHaveBeenCalled();
});
it("does not offer an incomplete or incorrectly bound set of copies", async () => {
  const f = fixture();
  f.reader.transcript = vi.fn(async () => null);
  render(createElement(Harness, { reader: f.reader, done: vi.fn() }));
  await screen.findByText("暂时无法核对不同内容，尚未作出选择。");
  expect(screen.queryByRole("button", { name: "使用这份内容" })).toBeNull();
  expect(f.run).not.toHaveBeenCalled();
  expect(f.reader.continuation?.options).not.toHaveBeenCalled();
});
