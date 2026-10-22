import { afterEach, expect, it, vi } from "vitest";
import {
  prepareApplicationInput,
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
