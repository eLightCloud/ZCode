import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { continuationControl } from "../src/zcode-protocol/continuation-control.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

it("revalidates the exact model after staging but never blocks an already completed activation ACK retry", async () => {
  const root=await mkdtemp(join(tmpdir(),"activation-model-")),operation=randomUUID();
  const selection={providerId:"target",modelId:"chosen",options:{reasoningLevel:"disabled"}};
  let state="applied";
  const validate=vi.fn(()=>false),settle=vi.fn(async()=>true);
  const control=vi.fn(async(input:{kind:string})=>{
    if(input.kind==="activate")state="active";
    return {session:"s",operation,state,generation:1,version:"v",digest:null};
  });
  // Only protocol dependencies used by this failure path; no app or default database is opened.
  const context={deps:{cwd:root,validateContinuationSelection:validate,sessionStore:{
    getSession:async()=>null,controlContinuation:control,
    exportTextCheckpoint:async()=>({modelSelection:selection,messages:[]}),
  }},sessionResidentPool:{settleForContinuation:settle}} as unknown as ZCodeProtocolAgentServerContext;
  try {
    const request={kind:"activate",session:"s",operation,version:"v",generation:1};
    await expect(continuationControl(context,request)).rejects.toMatchObject({code:"model_unavailable"});
    expect(state).toBe("applied");expect(control.mock.calls.some(([value])=>value.kind==="activate")).toBe(false);
    expect(validate).toHaveBeenCalledWith(selection,[]);
    state="active";validate.mockClear();
    expect((await continuationControl(context,request)).state).toBe("active");
    expect(validate).not.toHaveBeenCalled();
  } finally {await rm(root,{recursive:true,force:true});}
});
