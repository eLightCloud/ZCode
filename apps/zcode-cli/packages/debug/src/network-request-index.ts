import type { NetworkRequestRecord } from "./shared.js";

export function mergeNetworkRequest(
  current: NetworkRequestRecord[],
  next: NetworkRequestRecord,
): NetworkRequestRecord[] {
  const byId = new Map(current.map((request) => [request.id, request]));
  byId.set(next.id, next);
  return [...byId.values()]
    .toSorted((left, right) => compareDateDesc(left.startedAt, right.startedAt))
    .slice(0, 200);
}

export function compareDateDesc(left?: string, right?: string): number {
  return new Date(right ?? 0).getTime() - new Date(left ?? 0).getTime();
}
