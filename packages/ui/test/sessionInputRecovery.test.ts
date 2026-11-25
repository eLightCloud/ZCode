import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";

describe("input against a retired session subscription", () => {
  it.each(["ready", "failed", "guard.busy", "transport"] as const)(
    "recovers only a proven pre-admission rejection (%s)",
    async (outcome) => {
      const send = vi
        .fn()
        .mockResolvedValueOnce({ status: "rejected", reasonCode: "proto.sessionNotFound" })
        .mockResolvedValue({ status: "accepted" });
      if (outcome === "guard.busy")
        send.mockReset().mockResolvedValue({ status: "rejected", reasonCode: outcome });
      if (outcome === "transport") send.mockReset().mockRejectedValue(new Error("disconnected"));
      const listen = () => () => {};
      const transport = {
        sendCommand: send,
        onFrame: listen,
        onAssemblyFault: listen,
        onRuntimeRestart: listen,
      } as unknown as ConversationTransport;
      const connect = vi
        .spyOn(ConversationProjectionStore.prototype, "connect")
        .mockResolvedValue();
      const layer = new SessionDataLayer({ transport });
      try {
        const store = layer.acquire("s").store;
        let state = {
          ...store.getState(),
          subscriptionId: "old",
          status: "live" as const,
          snapshot: { sessionId: "s" },
        };
        vi.spyOn(store, "getState").mockImplementation(
          () => state as ReturnType<typeof store.getState>,
        );
        const retry = vi.spyOn(store, "retry").mockImplementation(async () => {
          const snapshot = { sessionId: "s", runtimeInitialization: { status: "initializing" } };
          state = { ...state, subscriptionId: "new", snapshot };
        });
        vi.spyOn(store, "subscribe").mockImplementation((listener) => {
          queueMicrotask(() => {
            expect(send).toHaveBeenCalledTimes(1);
            const snapshot = { sessionId: "s", runtimeInitialization: { status: outcome } };
            state = { ...state, snapshot };
            listener();
          });
          return () => {};
        });
        const envelope = {
          sessionId: "s",
          commandId: "original",
          type: "sendText",
        } as CommandEnvelope;
        const context = { projectId: null };
        const result = layer.sendCommand(envelope, context);
        if (outcome === "transport") await expect(result).rejects.toThrow("disconnected");
        else expect((await result).status).toBe(outcome === "ready" ? "accepted" : "rejected");
        expect(retry).toHaveBeenCalledTimes(outcome === "failed" || outcome === "ready" ? 1 : 0);
        expect(send).toHaveBeenCalledTimes(outcome === "ready" ? 2 : 1);
        for (const call of send.mock.calls) expect(call).toEqual([envelope, context]);
      } finally {
        layer.dispose();
        connect.mockRestore();
      }
    },
  );
});
