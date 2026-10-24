import type { ConversationRuntimePort,ConversationRuntimeCommand } from "@zcode/shared";
import { conversationIndexProjectionSchema,conversationRuntimeResultSchema } from "@zcode/shared";
import type { TaskIndexRepo } from "./taskIndexRepo.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import { getConversationWorkspaceDir } from "../paths.js";

/** Native Host joins two existing owners. Neither index nor Core receives a second queue. */
export function createConversationRuntimeHost(options:{runtime:ConversationRuntimePort;index:TaskIndexRepo;
  agent:Pick<IZCodeAgentService,'captureTextCheckpoint'>;
  beforeActivate?:(input:Extract<ConversationRuntimeCommand,{kind:'activate'}>)=>Promise<void>;
}):ConversationRuntimePort {
  const tails=new Map<string,Promise<unknown>>();
  async function run(input:ConversationRuntimeCommand) {
    const target={workspacePath:getConversationWorkspaceDir(),taskId:input.session,operation:input.operation};
    if(input.kind==='close') {
      let current;
      try {current=await options.runtime.control({kind:'read',session:input.session,operation:input.operation});}
      catch(error) {
        if(!(error&&typeof error==='object'&&'data' in error&&error.data&&typeof error.data==='object'&&
          'code' in error.data&&error.data.code==='not_found'))throw error;
      }
      if(current?.operation===input.operation&&['active','cancelled'].includes(current.state))return current;
      await options.index.controlConversationIndexBarrier({...target,hold:true});
    }
    if(input.kind==='activate') {
      const current=await options.runtime.control({kind:'read',session:input.session,operation:input.operation});
      if(current.operation===input.operation&&current.state==='active'&&current.generation===input.generation&&current.version===input.version)
        return options.runtime.control(input);
      await options.index.controlConversationIndexBarrier({...target,hold:true});
      await options.beforeActivate?.(input);
    }
    const value=await options.runtime.control(input);
    if(input.kind==='capture') {
      const management=await options.index.withConversationSyncFacts({...target,continuationOperation:input.operation},async(facts)=>facts);
      return conversationRuntimeResultSchema.parse({...value,management});
    }
    if(input.kind==='apply') {
      if(!value.management)throw new Error('continuation_management_unknown');
      const captured=await options.agent.captureTextCheckpoint({workspacePath:target.workspacePath,
        sessionId:input.session,includeIndexProjection:true});
      const projection=conversationIndexProjectionSchema.parse(captured.indexProjection);
      if(projection.meta.taskId!==input.session)throw new Error('continuation_identity_mismatch');
      await options.index.applyContinuationIndex({operation:input.operation,management:value.management,
        searchableText:projection.searchableText,meta:{...projection.meta,
          workspacePath:target.workspacePath,workspacePurpose:'conversation',provider:'glm'}});
    }
    if(input.kind==='activate'||input.kind==='cancel')
      await options.index.controlConversationIndexBarrier({...target,hold:false});
    return value;
  }
  return { control(input) {
    const previous=tails.get(input.session)??Promise.resolve();
    const pending=previous.catch(()=>{}).then(()=>run(input));tails.set(input.session,pending);
    void pending.finally(()=>{if(tails.get(input.session)===pending)tails.delete(input.session);}).catch(()=>{});
    return pending;
  }};
}
