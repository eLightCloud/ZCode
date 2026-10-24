import { inspectTrace, type ObservationOptions } from "./contract.js";
/** Use explicit observation paths for isolated reads. */
export async function exampleTraceRead(traceId: string, sources: ObservationOptions) {
  return await inspectTrace(traceId, sources);
}
