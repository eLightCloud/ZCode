import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { createConversationSyncOutbox } from "../src/conversation-sync/outbox.js";
import { checkpoint } from "../checks/sync-fixture.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, {recursive:true,force:true}))); });
async function setup() { const root=await mkdtemp(join(tmpdir(),"control-identity-"));roots.push(root);return join(root,"sync.sqlite"); }
it("enrolls one persistent self-certifying native key without exporting its private material", async () => {
  const path=await setup(),a=createConversationSyncOutbox(path),b=createConversationSyncOutbox(path);
  const key=a.controlIdentity(true);
  expect(b.controlIdentity().publicKey).toBe(key.publicKey);
  expect(Object.keys(key).sort()).toEqual(["bound","changed","location","publicKey"]);
  expect(a.location()).toBe(key.location);expect(b.location()).toBe(key.location);
  const bytes=createHash("sha256").update(Buffer.from(key.publicKey,"base64")).digest().subarray(0,16);
  bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;
  expect(key.location.replace("host:","").replaceAll("-","")).toBe(bytes.toString("hex"));
  const nonce=randomBytes(32).toString("base64url"),signature=a.signControlChallenge(nonce);
  const publicKey=createPublicKey({key:Buffer.from(key.publicKey,"base64"),format:"der",type:"spki"});
  expect(verify(null,Buffer.from("zcode-native-control-v1:"+nonce),publicKey,Buffer.from(signature,"base64"))).toBe(true);
  expect(verify(null,Buffer.from("zcode-native-control-v1:"+randomBytes(32).toString("base64url")),publicKey,Buffer.from(signature,"base64"))).toBe(false);
  a.close();b.close();const reopened=createConversationSyncOutbox(path);
  expect(reopened.controlIdentity().publicKey).toBe(key.publicKey);reopened.close();
  if(process.platform!=="win32")expect((await stat(path)).mode&0o777).toBe(0o600);
});
it("never rewrites an unconfirmed operation and preserves exact baseline history on explicit identity renewal", async () => {
  const path=await setup(),box=createConversationSyncOutbox(path);
  const scope={tenant:randomUUID(),subject:randomUUID()},cp=checkpoint("identity-session");
  const baseline={id:"saved-base",parent:null,location:box.location(),generation:1,checkpoint:cp};
  const operation=randomUUID();box.adopt(scope,baseline,1,operation);
  const request={session:cp.session.id,operation:randomUUID(),command:{kind:"receive" as const,version:{...baseline,id:"pending",parent:baseline.id}}};
  box.stage(scope,request);
  const old=box.location();expect(()=>box.controlIdentity(true)).toThrow("blocked");
  expect(box.location()).toBe(old);expect(box.pending(scope)).toEqual([request]);
  box.close();
  // A separate confirmed installation demonstrates renewal without touching session/plugin stores.
  const other=createConversationSyncOutbox(await setup());other.adopt(scope,baseline,1,operation);
  other.bindInput(scope,"original-command",cp.session.id);other.controlIdentity(true);
  expect(other.baseline(scope,cp.session.id)).toEqual(baseline);
  expect(other.branchGeneration(scope,cp.session.id)).toBe(0);expect(other.branchMode(scope,cp.session.id)).toBe("offline");
  expect(other.ownsSession(scope,cp.session.id)).toBe(true);other.close();
});
