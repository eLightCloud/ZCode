import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRootTraceContext } from "@zcode/contracts";
import { NodeDeliverableStore } from "../src/storage/deliverable-store.js";

describe("explicit final file snapshots", () => {
  let root: string;
  let workspace: string;
  let store: NodeDeliverableStore;
  const trace = createRootTraceContext();
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zcode-deliverables-"));
    workspace = join(root, "workspace");
    await mkdir(workspace);
    store = new NodeDeliverableStore(join(root, "snapshots"));
  });
  afterEach(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });

  const publish = (path: string, requestKey: string, extra = {}) =>
    store.publish({
      workspaceKey: "workspace-identity",
      workspacePath: workspace,
      sessionId: "session",
      turnId: "turn",
      sourcePath: path,
      requestKey,
      trace,
      ...extra,
    });

  it("replays one declaration and reads exact binary after workspace deletion and cold restart", async () => {
    const data = Buffer.from([0, 255, 13, 10, 128]);
    await writeFile(join(workspace, "result.zip"), data);
    const first = await publish("result.zip", "call:1");
    await writeFile(join(workspace, "result.zip"), "changed");
    expect(await publish("result.zip", "call:1")).toEqual(first);
    await expect(publish("other.zip", "call:1")).rejects.toThrow("request_conflict");
    expect(first.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    await rm(workspace, { recursive: true });
    store.close();
    store = new NodeDeliverableStore(join(root, "snapshots"));
    expect(
      (await store.list({ workspaceKey: first.workspaceKey, after: 0, limit: 100 })).entries,
    ).toEqual([first]);
    expect(
      await store.read({
        workspaceKey: first.workspaceKey,
        id: first.id,
        version: first.version,
        offset: 0,
        length: 10,
      }),
    ).toEqual(new Uint8Array(data));
    await expect(
      store.read({ workspaceKey: "other", id: first.id, version: 1, offset: 0, length: 10 }),
    ).rejects.toThrow("not_found");
  });

  it("lists all CSVs beyond preview limits with durable pagination and accepts empty files", async () => {
    for (let index = 0; index < 22; index++) {
      const path = `${index}.csv`;
      await writeFile(join(workspace, path), index ? "a,b\n1,2\n" : "");
      await publish(path, `call:${index}`);
    }
    const first = await store.list({ workspaceKey: "workspace-identity", after: 0, limit: 10 });
    const second = await store.list({
      workspaceKey: "workspace-identity",
      after: first.cursor,
      limit: 100,
    });
    expect(first.entries.length + second.entries.length).toBe(22);
    expect(first.entries[0]?.size).toBe(0);
  });

  it("rejects escapes and publishes revisions only against an exact current predecessor", async () => {
    await writeFile(join(root, "outside.csv"), "outside");
    await symlink(join(root, "outside.csv"), join(workspace, "link.csv"));
    await expect(publish("../outside.csv", "escape")).rejects.toThrow("outside_workspace");
    await expect(publish("link.csv", "link")).rejects.toThrow("outside_workspace");
    await writeFile(join(workspace, "result.csv"), "v1");
    const v1 = await publish("result.csv", "first");
    await writeFile(join(workspace, "result.csv"), "v2");
    const v2 = await publish("result.csv", "second", { previous: { id: v1.id, version: 1 } });
    expect(v2.id).toBe(v1.id);
    expect(v2.version).toBe(2);
    await expect(
      publish("result.csv", "third", { previous: { id: v1.id, version: 1 } }),
    ).rejects.toThrow("revision_conflict");
    const unrelated = await publish("result.csv", "independent");
    expect(unrelated.id).not.toBe(v1.id);
  });

  it("coalesces concurrent retries without replacing the winning snapshot", async () => {
    await writeFile(join(workspace, "result.csv"), "immutable");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => publish("result.csv", "same")),
    );
    expect(new Set(results.map((entry) => entry.id)).size).toBe(1);
    expect(
      (await store.list({ workspaceKey: "workspace-identity", after: 0, limit: 100 })).entries,
    ).toHaveLength(1);
  });
  it("scopes reused provider tool-call keys to their original session and turn", async () => {
    await writeFile(join(workspace, "reuse.csv"), "x");
    const first = await publish("reuse.csv", "provider-call:0", {
      sessionId: "first",
      turnId: "turn-a",
    });
    const second = await publish("reuse.csv", "provider-call:0", {
      sessionId: "second",
      turnId: "turn-a",
    });
    const third = await publish("reuse.csv", "provider-call:0", {
      sessionId: "first",
      turnId: "turn-b",
    });
    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(
      (await publish("reuse.csv", "provider-call:0", { sessionId: "first", turnId: "turn-a" })).id,
    ).toBe(first.id);
  });
  it("releases only exact snapshot bytes and keeps a replay tombstone", async () => {
    await writeFile(join(workspace, "release.csv"), "synthetic");
    const file = await publish("release.csv", "release:1");
    await expect(store.release({ ...file, sha256: "0".repeat(64) })).rejects.toThrow();
    const reference = {
      workspaceKey: file.workspaceKey,
      id: file.id,
      version: file.version,
      sha256: file.sha256,
    };
    await store.release(reference);
    await store.release(reference);
    expect(await publish("release.csv", "release:1")).toEqual(file);
    await expect(
      store.read({
        workspaceKey: file.workspaceKey,
        id: file.id,
        version: file.version,
        offset: 0,
        length: 1,
      }),
    ).rejects.toThrow("deliverable_snapshot_released");
    expect(
      (await store.list({ workspaceKey: file.workspaceKey, after: 0, limit: 100 })).entries,
    ).toHaveLength(1);
  });
});
