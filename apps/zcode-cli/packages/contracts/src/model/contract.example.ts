import { runWithModelInvocationContext } from "./invocation-context.js";
import type { ModelInvocationContext } from "./contract.js";

/** 同一异步调用链沿既有 context carrier 传播，不生成第二个授权结果或队列。 */
export function withinModelInvocation<T>(context: ModelInvocationContext, run: () => T): T {
  return runWithModelInvocationContext(context, run);
}
