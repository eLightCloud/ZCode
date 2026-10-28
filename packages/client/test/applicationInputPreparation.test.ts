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

it("reports the safe stalled stage without retaining transport text", async () => {
  vi.useFakeTimers();
  setApplicationInputPreparation(
    async (input) => {
      input.reportStage("conversation_authorize");
      await new Promise(() => {});
    },
    { required: true },
  );
  const result = prepareApplicationInput({ envelope: { type: "createSession" } } as never);
  const rejected = expect(result).rejects.toMatchObject({
    code: "application_input_unconfirmed",
    stage: "conversation_authorize",
    reason: "timeout",
  });
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
});

it("allows optional observation to expire only after required preparation succeeds", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const optional = vi.fn(async (input) => {
    signal = input.signal;
    await new Promise(() => {});
  });
  setApplicationInputPreparation(async () => {}, { required: true, optional });
  const result = prepareApplicationInput({ envelope: { type: "createSession" } } as never);
  await vi.advanceTimersByTimeAsync(5000);
  await expect(result).resolves.toBeUndefined();
  expect(optional).toHaveBeenCalledOnce();
  expect(signal?.aborted).toBe(true);
});

it("never starts optional observation when required admission rejects", async () => {
  const optional = vi.fn();
  setApplicationInputPreparation(
    async () => {
      throw new ApplicationInputRejected("conversation_owner_elsewhere");
    },
    { required: true, optional },
  );
  await expect(
    prepareApplicationInput({ envelope: { type: "sendText" } } as never),
  ).rejects.toMatchObject({ code: "conversation_owner_elsewhere" });
  expect(optional).not.toHaveBeenCalled();
});

it("cancels the old account while waiting for optional observation", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  setApplicationInputPreparation(async () => {}, {
    required: true,
    optional: async () => {
      started();
      await new Promise(() => {});
    },
  });
  const result = prepareApplicationInput({ envelope: { type: "sendText" } } as never);
  const rejected = expect(result).rejects.toMatchObject({
    code: "application_input_unconfirmed",
    reason: "cancelled",
  });
  await entered;
  setApplicationInputPreparation(undefined);
  await rejected;
});

it("does not allow a replaced registration to dispatch even if it returns immediately", async () => {
  setApplicationInputPreparation(
    async () => {
      setApplicationInputPreparation(undefined);
    },
    { required: true },
  );
  await expect(
    prepareApplicationInput({ envelope: { type: "createSession" } } as never),
  ).rejects.toMatchObject({ reason: "cancelled" });
});

it("drops invalid diagnostic stages and unknown error contents", async () => {
  setApplicationInputPreparation(
    async (input) => {
      input.reportStage("secret-token=this-must-not-escape");
      throw new Error("secret-token=this-must-not-escape");
    },
    { required: true },
  );
  await expect(
    prepareApplicationInput({ envelope: { type: "createSession" } } as never),
  ).rejects.toMatchObject({
    message: "application_input_unconfirmed",
    stage: "application_preparation",
    reason: "failed",
  });
});
