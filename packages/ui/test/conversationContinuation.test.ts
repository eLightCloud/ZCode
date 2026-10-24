// @vitest-environment jsdom
import { createElement } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  ConversationChoiceError,
  type ConversationHistoryReader,
  type ConversationContinuationResult,
} from "@zcode/shared";
import {
  ConversationContinuation,
  type ConversationContinuationLabels,
} from "../src/components/ConversationContinuation.js";

afterEach(cleanup);
const labels: ConversationContinuationLabels = {
  target: "Target",
  prepareTarget: "Prepare target",
  choose: "Choose whole copy",
  handoff: "Online handoff",
  offline: "Offline branch",
  warning: "Other copies and business effects remain.",
  offlineWarning: "Source may still execute; this creates a separate branch.",
  confirm: "Confirm",
  back: "Back",
  retry: "Retry original",
  cancel: "Cancel preparation",
  open: "Open conversation",
  loading: "Checking",
  unavailable: "Unconfirmed",
  waiting: "Waiting",
  busy: "Accepted work pending",
  stale: "Candidates changed",
  ready: "Recovery ready",
  cancelled: "Cancelled",
  forwardOnly: "Forward only",
  cancelling: "Cancelling",
};
function fixture() {
  const options = {
    session: "s",
    revision: 4,
    candidates: ["v", "other"],
    active: { location: "desktop", generation: 1, version: "v" },
    pending: null,
    handoff: null,
    inflight: null,
    targets: [{ location: "cloud", label: "Test cloud", instanceId: "cloud-instance" }],
  };
  const continuation = {
    options: vi.fn(async () => options),
    run: vi.fn(
      async (input): Promise<ConversationContinuationResult> => ({
        session: "s",
        operation: input.operation,
        status: "ready",
        phase: "ready",
        location: "cloud",
        version: "v",
      }),
    ),
    cancel: vi.fn(
      async (input): Promise<ConversationContinuationResult> => ({
        session: "s",
        operation: input.operation,
        status: "cancelled",
        phase: "cancelled",
        location: "cloud",
        version: "v",
      }),
    ),
  };
  const reader: ConversationHistoryReader = {
    history: async () => [],
    transcript: async () => null,
    continuation,
  };
  return { reader, continuation };
}
it("requires whole-copy confirmation and explicit open after actual native readiness", async () => {
  const { reader, continuation } = fixture(),
    onReady = vi.fn();
  render(
    createElement(ConversationContinuation, {
      reader,
      session: "s",
      version: "v",
      labels,
      onReady,
    }),
  );
  await screen.findByText("Test cloud");
  expect(continuation.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: labels.choose }));
  expect(screen.getByText(labels.warning)).toBeTruthy();
  expect(continuation.run).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: labels.confirm }));
  await screen.findByText(labels.ready);
  expect(continuation.run.mock.calls[0]![0]).toMatchObject({
    kind: "select",
    version: "v",
    candidates: ["v", "other"],
    revision: 4,
    target: "cloud",
  });
  expect(onReady).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: labels.open }));
  expect(onReady).toHaveBeenCalledWith("s", "cloud", "cloud-instance");
});
it("keeps original operation and input fingerprint after an ambiguous response", async () => {
  const { reader, continuation } = fixture();
  continuation.run.mockRejectedValueOnce(new ConversationChoiceError("unavailable"));
  render(createElement(ConversationContinuation, { reader, session: "s", version: "v", labels }));
  await screen.findByText("Test cloud");
  fireEvent.click(screen.getByRole("button", { name: labels.handoff }));
  fireEvent.click(screen.getByRole("button", { name: labels.confirm }));
  await screen.findByText(labels.unavailable);
  fireEvent.click(screen.getByRole("button", { name: labels.retry }));
  await screen.findByText(labels.ready);
  expect(continuation.run.mock.calls).toHaveLength(2);
  expect(continuation.run.mock.calls[1]![0]).toEqual(continuation.run.mock.calls[0]![0]);
});
it("states offline branching risk and resumes a durable in-flight intent after reload", async () => {
  const { reader, continuation } = fixture();
  continuation.run.mockImplementation(async (input) => ({
    session: "s",
    operation: input.operation,
    status: "waiting",
    phase: "settling",
    location: "cloud",
    version: "v",
    reason: "busy",
  }));
  render(createElement(ConversationContinuation, { reader, session: "s", version: "v", labels }));
  await screen.findByText("Test cloud");
  fireEvent.click(screen.getByRole("button", { name: labels.offline }));
  expect(screen.getByText(labels.offlineWarning)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: labels.confirm }));
  await screen.findByText(labels.busy);
  fireEvent.click(screen.getByRole("button", { name: labels.cancel }));
  await screen.findByText(labels.cancelled);
  expect(continuation.cancel.mock.calls[0]![0].operation).toEqual(
    continuation.run.mock.calls[0]![0].operation,
  );
  await waitFor(() => expect(screen.queryByRole("button", { name: labels.open })).toBeNull());
});

it("prepares a platform location only after a separate user action, without choosing or sending", async () => {
  const { reader, continuation } = fixture();
  const options = await continuation.options();
  continuation.options.mockClear();
  continuation.options
    .mockResolvedValueOnce({ ...options, targets: [] })
    .mockResolvedValue(options);
  const prepareTarget = vi.fn(async () => {});
  reader.continuation = { ...continuation, prepareTarget };
  render(createElement(ConversationContinuation, { reader, session: "s", version: "v", labels }));
  await screen.findByRole("button", { name: labels.prepareTarget });
  expect(prepareTarget).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: labels.prepareTarget }));
  await screen.findByText("Test cloud");
  expect(prepareTarget).toHaveBeenCalledWith("s", expect.any(AbortSignal));
  expect(continuation.run).not.toHaveBeenCalled();
  expect(screen.getByRole("combobox", { name: labels.target })).toBeTruthy();
});
