import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

/** Several real Hosts start against the same previous-version file. No mock SQLite. */
export async function checkConcurrentOutboxUpgrade() {
  const root = await mkdtemp(join(tmpdir(), "sync-concurrent-open-"));
  const path = join(root, "outbox.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`create table sync_outbox(tenant text,subject text,session text,operation text,fingerprint text,request text,receipt text,sequence integer);
    create table sync_cursor(tenant text,subject text,cursor integer,primary key(tenant,subject));
    pragma application_id=1514361689; pragma user_version=1;`);
  db.close();
  const children = Array.from({ length: 8 }, () =>
    spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "-e",
        `
    const {createConversationSyncOutbox} = await import(process.argv[1]);
    process.stdout.write('ready\\n');
    for await (const chunk of process.stdin) { if(chunk.toString().includes('go')) break; }
    try { const db=createConversationSyncOutbox(process.argv[2]);
      process.stdout.write(JSON.stringify({location:db.location()})+'\\n'); db.close(); }
    catch (error) { process.stderr.write(JSON.stringify({name:error.name,code:error.code,message:error.message})+'\\n'); process.exitCode=1; }
  `,
        import.meta.resolve("@zcode/adapters/conversation-sync"),
        path,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    ),
  );
  try {
    const results = children.map((child) => {
      let stdout = "",
        stderr = "";
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (stdout.includes("ready\n")) ready();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const finished = once(child, "exit").then(([code]) => {
        ready();
        return { code, stdout, stderr };
      });
      return { started, finished };
    });
    await Promise.all(results.map((result) => result.started));
    children.forEach((child) => {
      if (child.exitCode === null) child.stdin.end("go\n");
    });
    const outputs = await Promise.all(results.map((result) => result.finished));
    const locations = outputs.map(({ code, stdout, stderr }) => {
      assert.equal(code, 0, stderr);
      return JSON.parse(stdout.split("\n").filter(Boolean).at(-1)!);
    });
    assert.equal(new Set(locations.map((value) => value.location)).size, 1);
  } finally {
    children.forEach((child) => {
      if (child.exitCode === null) child.kill();
    });
    await rm(root, { recursive: true, force: true });
  }
}
