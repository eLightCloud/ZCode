import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ConversationRuntimeHostOptions } from "./contract.js";
import { prepareNativeRuntimeHost } from "./contract.example.js";

it("does not invent model capability or replace the Core's read-only barrier result", async () => {
  const operation = randomUUID();
  const barrier = {
    state: "closed" as const,
    session: "contract-session",
    operation,
    generation: 1,
    version: null,
    digest: null,
  };
  const control = vi.fn(async () => barrier);
  const host = prepareNativeRuntimeHost({
    runtime: { control },
    index: {} as ConversationRuntimeHostOptions["index"],
    agent: {} as ConversationRuntimeHostOptions["agent"],
  });
  expect(host.models).toBeUndefined();
  const query = { kind: "read" as const, session: "contract-session", operation };
  expect(await host.control(query)).toBe(barrier);
  expect(control).toHaveBeenCalledExactlyOnceWith(query);
});
