import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import {
  checkpointArtifactUris,
  textCheckpointSchema,
  syncVersionSchema,
  type SessionId,
} from "@zcode/contracts";
import { createNodeToolArtifactStore, createSqliteSessionStore } from "../src/storage/index.js";
import { checkpoint } from "../checks/sync-fixture.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "native-fixed-files-"));
  roots.push(root);
  const artifactRoot = join(root, "artifacts");
  const artifacts = createNodeToolArtifactStore({
    rootDir: artifactRoot,
    imageCacheRootDir: join(root, "images"),
    videoCacheRootDir: join(root, "videos"),
  });
  return { root, artifactRoot, artifacts };
}
it("restores actual producer bytes at the exact native URI into an independent root, create-only and retryable", async () => {
  const source = await setup(),
    target = await setup(),
    session = "file-session" as SessionId;
  const content = "data:image/png;base64,aGVsbG8=";
  const produced = await source.artifacts.writeToolResultArtifact({
    sessionId: session,
    toolCallId: "attachment-1",
    toolName: "attachment:image/png",
    content,
    contentType: "text/plain",
  });
  const captured = await source.artifacts.readFixedArtifact!({
    sessionId: session,
    uri: produced.uri,
  });
  await Promise.all(
    Array.from({ length: 8 }, () =>
      target.artifacts.restoreFixedArtifact!({
        sessionId: session,
        uri: produced.uri,
        bytes: captured.bytes,
        contentType: captured.contentType,
      }),
    ),
  );
  await rm(source.root, { recursive: true, force: true });
  const restored = await target.artifacts.readToolResultArtifact({ uri: produced.uri });
  expect(restored.content).toBe(content);
  await expect(
    target.artifacts.restoreFixedArtifact!({
      sessionId: session,
      uri: produced.uri,
      bytes: Buffer.from("changed"),
      contentType: "text/plain",
    }),
  ).rejects.toThrow("artifact_collision");
  expect((await target.artifacts.readToolResultArtifact({ uri: produced.uri })).content).toBe(
    content,
  );
});
it("rejects path and symlink escapes instead of copying unrelated directory files", async () => {
  const { root, artifactRoot, artifacts } = await setup(),
    session = "file-session" as SessionId;
  const uri = "zcode-artifact://" + session + "/tool-result-" + randomUUID();
  await mkdir(artifactRoot);
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(artifactRoot, session), "dir");
  await expect(
    artifacts.restoreFixedArtifact!({
      sessionId: session,
      uri,
      bytes: Buffer.from("private"),
      contentType: "text/plain",
    }),
  ).rejects.toThrow("artifact_path");
  await expect(
    artifacts.readFixedArtifact!({ sessionId: session, uri: uri.replace(session, "../other") }),
  ).rejects.toThrow("artifact_identity");
});
it("checkpoint v3 preserves an explicit file part and requires its exact native manifest; older formats stay strict", async () => {
  const { root, artifacts } = await setup(),
    session = "file-session" as SessionId;
  const produced = await artifacts.writeToolResultArtifact({
    sessionId: session,
    toolCallId: "attachment-1",
    toolName: "attachment:pdf",
    content: "data:application/pdf;base64,cGRm",
    contentType: "text/plain",
  });
  const value = checkpoint(session),
    part = {
      id: "file-part",
      type: "file",
      mime: "application/pdf",
      filename: "synthetic.pdf",
      url: produced.uri,
      metadata: {
        storageKind: "artifact",
        artifactUri: produced.uri,
        recoverability: "provider_ready",
      },
    };
  const portable = textCheckpointSchema.parse({
    ...value,
    version: 3,
    messages: value.messages.map((message, index) =>
      index ? message : { ...message, parts: [...message.parts, part] },
    ),
  });
  expect(textCheckpointSchema.safeParse({ ...portable, version: 2 }).success).toBe(false);
  expect(checkpointArtifactUris(portable)).toEqual([produced.uri]);
  const saved = await artifacts.readFixedArtifact!({ sessionId: session, uri: produced.uri });
  const file = {
    uri: produced.uri,
    sha256: createHash("sha256").update(saved.bytes).digest("hex"),
    bytes: saved.bytes.length,
    contentType: saved.contentType,
  };
  const version = {
    id: "file-v1",
    parent: null,
    location: "desktop",
    generation: 0,
    checkpoint: portable,
    files: [file],
  };
  expect(syncVersionSchema.parse(version)).toEqual(version);
  expect(syncVersionSchema.safeParse({ ...version, files: [] }).success).toBe(false);
  const store = createSqliteSessionStore({ dbPath: join(root, "sessions.sqlite") });
  try {
    await store.importTextCheckpoint({
      checkpoint: portable,
      target: { projectID: "synthetic" as never, directory: root },
    });
    expect(await store.exportTextCheckpoint({ sessionID: session })).toEqual(portable);
  } finally {
    store.close();
  }
});
