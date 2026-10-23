import type { TraceDetailResponse } from "../src/shared.js";

import type { ObservationOptions } from "./types.js";

import { loadObservation, sourceStatuses } from "./analyzer-observation-source.js";

import { collectSessionsForTrace } from "./analyzer-trace-index.js";

import { buildTimeline } from "./analyzer-timeline.js";

import { buildTraceSpans } from "./analyzer-spans.js";

import { buildContextSnapshots, buildContextUsageSnapshots } from "./analyzer-context.js";

import { buildCacheReports } from "./analyzer-cache.js";

import { buildDeveloperRequests } from "./analyzer-model-requests.js";

export { listTraces } from "./analyzer-trace-index.js";

export async function inspectTrace(
  traceId: string,
  options: ObservationOptions = {},
): Promise<TraceDetailResponse> {
  const observation = await loadObservation({ ...options, traceId });
  const sessions = collectSessionsForTrace(traceId, observation, options.sessionId);
  const timeline = buildTimeline(traceId, sessions, observation);
  const spans = buildTraceSpans(traceId, sessions, observation);
  const contextSnapshots = buildContextSnapshots(traceId, observation);
  const contextUsageSnapshots = buildContextUsageSnapshots(traceId, sessions, observation);
  const cacheReports = buildCacheReports(traceId, sessions, observation);

  return {
    traceId,
    sessions: [...sessions].sort(),
    sources: sourceStatuses(observation),
    timeline,
    spans,
    contextSnapshots,
    contextUsageSnapshots,
    cacheReports,
    developerRequests: buildDeveloperRequests(observation, contextSnapshots, cacheReports),
  };
}
