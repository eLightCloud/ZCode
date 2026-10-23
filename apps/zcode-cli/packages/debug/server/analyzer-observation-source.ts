import type { SourceStatus } from "../src/shared.js";

import { loadEventLog, loadLogs, loadSqlite } from "./sources.js";

import type { LoadedObservation, ObservationOptions, SourceLoadResult } from "./types.js";

export async function loadObservation(options: ObservationOptions): Promise<LoadedObservation> {
  const [logs, events] = await Promise.all([loadLogs(options), loadEventLog(options)]);
  return {
    logs,
    events,
    db: loadSqlite(options),
  };
}

export function sourceStatuses(observation: LoadedObservation): SourceStatus[] {
  return [
    toSourceStatus(observation.logs),
    toSourceStatus(observation.events),
    toSourceStatus(observation.db),
  ];
}

export function toSourceStatus<TRecord>(source: SourceLoadResult<TRecord>): SourceStatus {
  return {
    kind: source.kind,
    label: source.label,
    path: source.path,
    available: source.records.length > 0,
    recordCount: source.records.length,
    warning: source.warning,
  };
}
