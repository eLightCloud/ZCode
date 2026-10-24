import { afterEach, expect, it, vi } from "vitest";
import {
  prepareApplicationInput,
  ApplicationInputRejected,
  setApplicationInputPreparation,
} from "../src/applicationInputPreparation.js";
import type { IZCodeAgentService } from "@zcode/services";
afterEach(() => {
  setApplicationInputPreparation(undefined);
  vi.useRealTimers();
});
it("bounds a stalled optional preparation and aborts late binding", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  setApplicationInputPreparation(async (input) => {
    signal = input.signal;
    await new Promise(() => {});
  });
  const params = {
    workspacePath: "/synthetic",
    envelope: { type: "sendText", commandId: "original", sessionId: "session" },
  } as Parameters<IZCodeAgentService["sendConversationCommandV4"]>[0];
  const original = JSON.stringify(params);
  const pending = prepareApplicationInput(params);
  await vi.advanceTimersByTimeAsync(5000);
  await pending;
  expect(signal?.aborted).toBe(true);
  expect(JSON.stringify(params)).toBe(original);
});
it("does not let preparation failure replace native command admission", async () => {
  setApplicationInputPreparation(async () => {
    throw new Error("synthetic");
  });
  await expect(
    prepareApplicationInput({
      workspacePath: "/synthetic",
      envelope: { type: "createSession" },
    } as Parameters<IZCodeAgentService["sendConversationCommandV4"]>[0]),
  ).resolves.toBeUndefined();
});

it("retains the draft when mandatory preparation fails unexpectedly", async () => {
  setApplicationInputPreparation(
    async () => {
      throw new Error("synthetic transport");
    },
    { required: true },
  );
  await expect(
    prepareApplicationInput({
      workspacePath: "/synthetic",
      envelope: { type: "sendText", commandId: "original", sessionId: "session" },
    } as Parameters<IZCodeAgentService["sendConversationCommandV4"]>[0]),
  ).rejects.toMatchObject({ code: "application_input_unconfirmed" });
});

it("preserves an explicit native/application rejection instead of dispatching through the offline fallback", async () => {
  setApplicationInputPreparation(
    async () => {
      throw new ApplicationInputRejected("conversation_owner_elsewhere");
    },
    { required: true },
  );
  await expect(
    prepareApplicationInput({
      workspacePath: "/synthetic",
      envelope: { type: "sendText", commandId: "original", sessionId: "session" },
    } as Parameters<IZCodeAgentService["sendConversationCommandV4"]>[0]),
  ).rejects.toMatchObject({ code: "conversation_owner_elsewhere" });
});
it("does not dispatch an unconfirmed mandatory preparation after its timeout", async () => {
  vi.useFakeTimers();
  setApplicationInputPreparation(
    async () => {
      await new Promise(() => {});
    },
    { required: true },
  );
  const pending = prepareApplicationInput({
    workspacePath: "/synthetic",
    envelope: { type: "sendText", commandId: "original", sessionId: "session" },
  } as Parameters<IZCodeAgentService["sendConversationCommandV4"]>[0]);
  const rejected = expect(pending).rejects.toMatchObject({ code: "application_input_unconfirmed" });
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
});
