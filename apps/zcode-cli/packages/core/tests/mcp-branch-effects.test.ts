import {describe,expect,it,vi} from "vitest";
import type {McpPort} from "@zcode/contracts";
import {createMcpToolEntry} from "../src/mcp/index.js";

const effect={server:"synthetic-business",owner:"synthetic-owner",operation:"mail-original",requestKey:"key-original",receiptUri:"mcp-effect://mail-original",outcome:"applied"};
function setup(decision="proceed",readOnly=false) {
  const write=vi.fn(async()=>({content:[{type:"text",text:"SYNTHETIC_NEW_RECEIPT"}]}));
  const check=vi.fn(async(request:any)=>({content:[],structuredContent:{decision,action:request.arguments.action,
    result:{content:[{type:"text",text:"SYNTHETIC_ORIGINAL_RECEIPT"}],_meta:{"zcode/effect":effect}}}}));
  const port={listTools:async()=>[{serverName:effect.server,toolName:"check_operation",inputSchema:{},annotations:{readOnlyHint:true}}],
    callTool:(request:any)=>request.toolName==="check_operation"?check(request):write()} as unknown as McpPort;
  const entry=createMcpToolEntry("mcp__synthetic_business__send",{serverName:effect.server,toolName:"send",effectCheckTool:"check_operation",inputSchema:{type:"object"},annotations:{readOnlyHint:readOnly}},port,false);
  const context={sessionId:"synthetic-session",traceId:"synthetic-trace",toolCallId:"new-call",abortSignal:new AbortController().signal,workingDirectory:"synthetic-workspace",
    sessionStore:{sessionEntries:async()=>[{type:"runtime/branch_effects",data:[effect]}]}};
  return {entry,context,port,write,check};
}
describe("cross-branch resource owner reconciliation",()=>{
  it("queries the resource owner before an independently confirmed new action",async()=>{
    const {entry,context,write,check}=setup();
    await entry.handler({requestKey:"key-new"},context as never);
    expect(check).toHaveBeenCalledOnce();expect(write).toHaveBeenCalledOnce();
    expect(check.mock.calls[0]![0].arguments.effects).toEqual([effect]);
  });
  it("returns the owner's original receipt for the original request without another write",async()=>{
    const {entry,context,write}=setup("replay");
    const result=await entry.handler({requestKey:"key-original"},context as never);
    expect(JSON.stringify(result)).toContain("SYNTHETIC_ORIGINAL_RECEIPT");expect(write).not.toHaveBeenCalled();
  });
  it.each(["unknown","blocked","requires_confirmation"])("blocks %s without inventing a new request",async decision=>{
    const {entry,context,write}=setup(decision);
    await expect(entry.handler({requestKey:"different-key"},context as never)).rejects.toThrow("branch_effect_verification_required");
    expect(write).not.toHaveBeenCalled();
  });
  it("does not let a mismatched owner response authorize the proposed action",async()=>{
    const {entry,context,check,write}=setup();
    check.mockImplementationOnce(async()=>({content:[],structuredContent:{decision:"proceed",action:{tool:"other",arguments:{}},result:{content:[]}}}));
    await expect(entry.handler({},context as never)).rejects.toThrow("branch_effect_result_unknown");expect(write).not.toHaveBeenCalled();
  });
  it("requires a read-only check capability and keeps unrelated reads available",async()=>{
    const {entry,context,port,write}=setup();
    port.listTools=async()=>[];
    await expect(entry.handler({},context as never)).rejects.toThrow("branch_effect_verification_required");expect(write).not.toHaveBeenCalled();
    const read=setup("unknown",true);await read.entry.handler({},read.context as never);expect(read.write).toHaveBeenCalledOnce();expect(read.check).not.toHaveBeenCalled();
  });
});
