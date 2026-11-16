import { afterEach, expect, it, vi } from "vitest";
import { createSessionId, type ModelRequest } from "@zcode/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";
import { createRecordingSubagentSessionStore } from "./subagent-test-store.js";
import { MemoryFileSystem } from "./memory-test-utils.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  let first = true;
  let extractionSignal: AbortSignal | undefined;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const runtime = createTestAgentRuntime(
    createSessionId("memory-deadline-regression"),
    {
      workingDirectory: "/workspace",
      memory: { cliStorageRoot: "/storage", enabled: true, use: true },
      titleGeneration: { enabled: false },
    },
    {
      eventStore: createTestSessionEventStore(),
      sessionStore: createRecordingSubagentSessionStore(),
      fileSystemPort: new MemoryFileSystem({}),
      modelFactory: createTestModelFactory({
        async generateText(request: ModelRequest) {
          if (JSON.stringify(request.messages).includes("memory extraction subagent") && first) {
            first = false;
            extractionSignal = request.abortSignal;
            notifyStarted();
            // 复现真实非流式请求一直 pending，adapter 只在取消时返回拒绝。
            await new Promise<never>((_, reject) => {
              request.abortSignal!.addEventListener(
                "abort",
                () => reject(request.abortSignal!.reason),
                { once: true },
              );
            });
          }
          return { text: "Nothing to save.", finishReason: "stop", usage: {} };
        },
      }),
    },
  );
  return { runtime, started, signal: () => extractionSignal };
}

it("cancels a stuck extraction at its deadline, releases residency and can process later work", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  await f.runtime.executeTurn("remember this durable preference");
  await f.started;
  expect(f.runtime.hasActiveOrQueuedTurnWork()).toBe(false);
  expect(f.runtime.hasResidencyBlockingWork()).toBe(true);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(f.signal()?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await f.runtime.drainMemoryExtractions(null);
  expect(f.signal()?.reason).toMatchObject({ name: "TimeoutError" });
  expect(f.runtime.hasResidencyBlockingWork()).toBe(false);
  await f.runtime.executeTurn("remember the later durable preference");
  await f.runtime.drainMemoryExtractions(null);
  expect(f.runtime.hasResidencyBlockingWork()).toBe(false);
});

it("session shutdown cancels extraction immediately rather than waiting for the deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  await f.runtime.executeTurn("remember this durable preference");
  await f.started;
  f.runtime.beginShutdown();
  await f.runtime.drainMemoryExtractions(null);
  expect(f.signal()?.aborted).toBe(true);
  expect(f.runtime.hasResidencyBlockingWork()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
