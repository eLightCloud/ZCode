import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ConversationRuntimePort } from "@zcode/shared";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";

const script = `
const readline=require('node:readline'),fs=require('node:fs');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);if(q.id===undefined)return;
 fs.appendFileSync(process.argv[2],JSON.stringify({method:q.method,cwd:process.cwd()})+'\\n');
 let result={};
 if(q.method==='session/continuation')result={session:q.params.session,operation:q.params.operation,state:'closed',generation:0,version:null,digest:null};
 if(q.method==='session/continuationContent')result={file:{uri:q.params.uri,sha256:'0'.repeat(64),bytes:1,contentType:'text/plain'},dataBase64:'eA=='};
 process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
});`;

it("routes both continuation control and attachment reads by the same trusted session mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-conversation-route-"));
  const path = join(root, "draft"),
    log = join(root, "requests.jsonl"),
    agentPath = join(root, "agent.cjs");
  await mkdir(path);
  await writeFile(agentPath, script);
  let port: ConversationRuntimePort | undefined;
  const resolveConversationWorkspace = vi.fn(async () => path);
  const service = createZCodeAgentService({
    resolveConversationWorkspace,
    onConversationRuntimeReady: (value) => {
      port = value;
    },
    commandResolver: ({ workspacePath }) => ({
      command: process.execPath,
      args: [agentPath, log],
      cwd: workspacePath,
    }),
  });
  const session = "session-routing",
    operation = randomUUID();
  try {
    expect(await port!.control({ kind: "read", session, operation })).toHaveProperty(
      "state",
      "closed",
    );
    await port!.content!({
      kind: "read",
      session,
      uri: `zcode-artifact://${session}/tool-result-${randomUUID()}`,
    });
    const calls = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    for (const method of ["session/continuation", "session/continuationContent"]) {
      expect(calls.filter((call) => call.method === method)).toEqual([
        { method, cwd: await realpath(path) },
      ]);
    }
    expect(resolveConversationWorkspace).toHaveBeenCalledTimes(2);
    expect(resolveConversationWorkspace).toHaveBeenCalledWith(session);
    resolveConversationWorkspace.mockRejectedValueOnce(
      new Error("conversation_sync_ambiguous_index"),
    );
    await expect(port!.control({ kind: "read", session, operation })).rejects.toThrow(
      "ambiguous_index",
    );
    expect((await readFile(log, "utf8")).trim().split("\n")).toHaveLength(calls.length);
  } finally {
    await service.disposeAllAndWait();
    await rm(root, { recursive: true, force: true });
  }
});
