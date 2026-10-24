import { expect, it } from "vitest";
import {
  createRuntimeCommandId,
  createRuntimeCommandQueue,
} from "../../src/runtime/command-queue.js";

it("keeps cancellation fenced to the exact admitted command and consumes it once", () => {
  const queue = createRuntimeCommandQueue();
  const oldCommand = createRuntimeCommandId();
  const nextCommand = createRuntimeCommandId();
  queue.markCancelPending(oldCommand);
  expect(queue.consumeCancelPending(nextCommand)).toBe(false);
  expect(queue.consumeCancelPending(oldCommand)).toBe(true);
  expect(queue.consumeCancelPending(oldCommand)).toBe(false);
});
