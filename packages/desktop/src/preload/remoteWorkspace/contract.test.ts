import { EventEmitter } from "node:events";
import type { IpcRenderer } from "electron";
import { expect, it, vi } from "vitest";
import { PlatformChannels } from "@zcode/shared";
import { createRemoteWorkspacePreload } from "./index.js";
it("releases the original remote session notification subscription", () => {
  const events = Object.assign(new EventEmitter(), { invoke: vi.fn() });
  const port = createRemoteWorkspacePreload(events as unknown as IpcRenderer);
  const callback = vi.fn();
  const off = port.onRemoteSessionReconnected(callback);
  const changed = { previousSessionId: "old-logical", sessionId: "new-logical" };
  events.emit(PlatformChannels.RemoteSessionReconnected, {}, changed);
  expect(callback).toHaveBeenCalledWith(changed);
  off();
  expect(events.listenerCount(PlatformChannels.RemoteSessionReconnected)).toBe(0);
});
