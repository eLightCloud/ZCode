import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { NodeDeliverableStore } from "@zcode/adapters/storage";
import { createRootTraceContext } from "@zcode/contracts";
import { nativeDeliverablesListSchema, zcodeProtocolMethods } from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";

it("reads cold immutable snapshots through public protocol without creating an Agent session", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-delivery-protocol-"));
  const workspacePath = join(root, "workspace"),
    storage = join(root, "storage");
  await mkdir(workspacePath);
  await writeFile(join(workspacePath, "final.csv"), "固定字节\n");
  const store = new NodeDeliverableStore(join(storage, "cli", "deliverables"));
  const original = await store.publish({
    workspacePath,
    workspaceKey: "opaque-identity",
    sessionId: "original",
    sourcePath: "final.csv",
    requestKey: "delivery",
    trace: createRootTraceContext(),
  });
  store.close();
  await rm(join(workspacePath, "final.csv"));
  vi.stubEnv("ZCODE_STORAGE_DIR", storage);
  const createZCodeApp = vi.fn(() => {
    throw new Error("must not create a session");
  });
  const server = new ZCodeProtocolAgentServer({
    createZCodeApp,
    cwd: workspacePath,
    version: "test",
  });
  try {
    const listed = await server.handleMessage({
      id: 1,
      method: zcodeProtocolMethods.deliverablesList,
      params: { workspacePath, workspaceIdentity: "opaque-identity", after: 0, limit: 100 },
    });
    expect(
      listed && "result" in listed && nativeDeliverablesListSchema.parse(listed.result).entries,
    ).toEqual([original]);
    const read = await server.handleMessage({
      id: 2,
      method: zcodeProtocolMethods.deliverableRead,
      params: {
        workspacePath,
        workspaceIdentity: "opaque-identity",
        id: original.id,
        version: 1,
        offset: 0,
        length: 512,
      },
    });
    expect(read && "result" in read && read.result).toEqual({
      dataBase64: Buffer.from("固定字节\n").toString("base64"),
    });
    const denied = await server.handleMessage({
      id: 3,
      method: zcodeProtocolMethods.deliverableRead,
      params: {
        workspacePath,
        workspaceIdentity: "other-identity",
        id: original.id,
        version: 1,
        offset: 0,
        length: 512,
      },
    });
    expect(denied && "error" in denied).toBe(true);
    const released = await server.handleMessage({
      id: 4,
      method: zcodeProtocolMethods.deliverableRelease,
      params: {
        workspacePath,
        workspaceIdentity: "opaque-identity",
        id: original.id,
        version: original.version,
        sha256: original.sha256,
      },
    });
    expect(released).toMatchObject({ result: { released: true } });
    expect(createZCodeApp).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
