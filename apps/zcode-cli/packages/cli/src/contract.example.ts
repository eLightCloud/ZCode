import { run, type RunContext, type RunDependencies } from "./contract.js";
/** 入口处理终端/退出码；执行只委托现有原生 app。 */
export async function exampleCliEntry(context: RunContext, dependencies: RunDependencies) {
  return await run(context, dependencies);
}
