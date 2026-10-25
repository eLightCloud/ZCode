import { describe, expect, it, vi } from "vitest";
import type { IpcRenderer } from "electron";
import { createRemoteWorkspacePreload } from "../src/preload/remoteWorkspace/index.js";

describe("remote workspace bind preload bridge", () => {
  it("restores structured reasonCode and retryable metadata for renderer callers", async () => {
    const ipc = {
      invoke: vi.fn().mockResolvedValue({
        success: false,
        error: "workspace migration conflict",
        reasonCode: "workspace-task-identity-conflict",
        retryable: false,
      }),
    } as unknown as IpcRenderer;
    const port = createRemoteWorkspacePreload(ipc);
    const error = await port
      .bindRemoteWorkspaceSessionContext({
        remoteSessionId: "owned-logical",
        workspacePath: "/owned/workspace",
      })
      .catch((value: unknown) => value);

    expect(error).toMatchObject({
      message: "workspace migration conflict",
      code: "workspace-task-identity-conflict",
      retryable: false,
    });
  });
});
