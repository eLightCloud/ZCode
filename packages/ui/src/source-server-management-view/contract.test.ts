// @vitest-environment node
import { expect, it, vi } from "vitest";
import { getSourceServerDisplayNameRegistry } from "./contract.js";
it("shares one projection per source service and removes observers without writing source state", async () => {
  let refresh = () => {};
  const getSnapshot = vi.fn(async () => ({
    servers: [{ sourceServerId: "synthetic-source", displayName: "Synthetic" }],
  }));
  const service = {
    getSnapshot,
    onDidChangeState: (listener: () => void) => {
      refresh = listener;
      return () => {};
    },
  } as unknown as Parameters<typeof getSourceServerDisplayNameRegistry>[0];
  const first = getSourceServerDisplayNameRegistry(service);
  expect(getSourceServerDisplayNameRegistry(service)).toBe(first);
  await vi.waitFor(() => expect(first.getSnapshot().get("synthetic-source")).toBe("Synthetic"));
  expect(getSnapshot).toHaveBeenCalledTimes(1);
  const changed = vi.fn();
  const dispose = first.subscribe(changed);
  dispose();
  getSnapshot.mockResolvedValue({ servers: [] });
  refresh();
  await vi.waitFor(() => expect(first.getSnapshot().size).toBe(0));
  expect(changed).not.toHaveBeenCalled();
});
