import { expect, it } from "vitest";
import { ChannelServer, ChannelClient } from "../src/channels.js";
import { createQueuePair } from "../src/protocol.js";
import { Event } from "../src/foundation.js";

it("disconnect cancellation does not settle an admitted service operation", async () => {
  const [serverProtocol, clientProtocol] = createQueuePair();
  const server = new ChannelServer(serverProtocol, "test");
  const client = new ChannelClient(clientProtocol);
  let entered!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const completed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  server.registerChannel("work", {
    call: async () => {
      entered();
      await completed;
      return undefined;
    },
    listen: () => Event.None,
  });
  const pending = client
    .getChannel("work")
    .call("run")
    .catch(() => undefined);
  try {
    await started;
    client.dispose();
    server.dispose();
    let settled = false;
    const retirement = server.whenCallsSettled().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await retirement;
    expect(settled).toBe(true);
  } finally {
    finish();
    client.dispose();
    server.dispose();
    await pending;
  }
});
