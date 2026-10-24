import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { type ProjectId, type SessionId } from "@zcode/contracts";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("portable text checkpoint / isolated cold resume", () => {
  it("fresh process resumes same identity without source data, then exports a return checkpoint", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-s0-cold-"));
    const sourceRoot = join(root, "source");
    const targetRoot = join(root, "target");
    const transfer = join(root, "checkpoint.json");
    const worker = fileURLToPath(new URL("./fixtures/text-checkpoint-worker.mts", import.meta.url));
    const loader = fileURLToPath(import.meta.resolve("tsx/esm"));
    const run = async (action: string, dataRoot: string) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--import", loader, worker, action, dataRoot, transfer],
        { timeout: 45_000 },
      );
      return JSON.parse(stdout) as {
        sessionId: string;
        calls: number;
        hasOriginalContext: boolean;
        messages: number;
      };
    };
    try {
      const source = await run("source", sourceRoot);
      // 不是同库重开：源进程已退出，整个源数据根在目标启动前移除。
      await rm(sourceRoot, { recursive: true, force: true });
      const target = await run("target", targetRoot);
      expect(target).toMatchObject({
        sessionId: source.sessionId,
        calls: 1,
        hasOriginalContext: true,
      });
      expect(target.messages).toBeGreaterThan(source.messages);
      const store = await createSqliteSessionStore({
        dbPath: join(root, "return", "sessions.sqlite"),
      });
      try {
        const checkpoint = JSON.parse(await readFile(`${transfer}.return`, "utf8"));
        await store.importTextCheckpoint({
          checkpoint,
          target: { projectID: "return-project" as ProjectId, directory: join(root, "return") },
        });
        const messages = await store.messages({ sessionID: source.sessionId as SessionId });
        expect(
          messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text),
        ).toEqual(["S0_SOURCE_PROMPT", "S0_SOURCE_REPLY", "S0_TARGET_PROMPT", "S0_TARGET_REPLY"]);
      } finally {
        store.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 100_000);
});
