import type {
  TimelineOptions,
  DataGroup as VisTimelineGroup,
  DataItem as VisTimelineItem,
} from "vis-timeline/standalone";

import "vis-timeline/styles/vis-timeline-graph2d.min.css";

import type { NetworkRequestRecord, TraceSpan } from "./shared";

import { ganttItemStyle } from "./gantt-style";

import {
  compareDateDesc,
  formatBytes,
  formatDuration,
  formatNetworkStatus,
  formatSpanDuration,
  formatSpanStatus,
} from "./debug-formatters.js";

import { laneLabels, laneOrder } from "./debug-view-config.js";

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

export function mergeNetworkSpans(
  spans: TraceSpan[],
  requests: NetworkRequestRecord[],
  traceId: string,
): TraceSpan[] {
  if (!traceId) return spans;
  const networkSpans = requests
    .filter((request) => request.traceId === traceId)
    .map(networkRequestToSpan);
  return [...spans, ...networkSpans];
}

export function networkRequestToSpan(request: NetworkRequestRecord): TraceSpan {
  return {
    id: `network:${request.id}`,
    traceId: request.traceId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    spanId: request.spanId,
    lane: "network",
    label: `${request.method} ${request.host}`,
    source: "network",
    startAt: request.startedAt,
    endAt: request.completedAt,
    status: request.status === "pending" ? "running" : request.status === "error" ? "error" : "ok",
    summary: `${request.method} ${request.url}\n${formatNetworkStatus(request)} · ${formatBytes(
      request.requestBodyBytes,
    )} up · ${formatBytes(request.responseBodyBytes)} down`,
    payload: request,
  };
}

export function filterNetworkRequests(
  requests: NetworkRequestRecord[],
  filter: string,
): NetworkRequestRecord[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return requests;
  return requests.filter((request) =>
    [
      request.traceId,
      request.sessionId,
      request.turnId,
      request.spanId,
      request.method,
      request.host,
      request.path,
      request.url,
      request.status,
      request.statusCode ? String(request.statusCode) : "",
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(normalized)),
  );
}

export function buildGanttGroups(spans: TraceSpan[]): VisTimelineGroup[] {
  const activeLanes = new Set(spans.map((span) => span.lane));
  return laneOrder
    .filter((lane) => activeLanes.has(lane))
    .map((lane, index) => ({
      id: lane,
      content: laneLabels[lane],
      order: index,
      className: `gantt-group lane-${lane}`,
    }));
}

export function buildGanttItems(spans: TraceSpan[]): VisTimelineItem[] {
  return spans.map((span) => {
    const runningEndAt =
      !span.endAt && span.status === "running" ? new Date().toISOString() : undefined;
    const type = span.endAt || runningEndAt ? "range" : "point";
    return {
      id: span.id,
      group: span.lane,
      content: ganttItemContent(span),
      title: escapeTimelineContent(ganttItemTitle(span)),
      start: span.startAt,
      end: span.endAt ?? runningEndAt,
      type,
      style: ganttItemStyle(type),
      className: `gantt-item lane-${span.lane} span-status-${span.status}`,
    };
  });
}

export function ganttItemContent(span: TraceSpan): string {
  return [
    `<span class="gantt-item-title">${escapeTimelineContent(span.label)}</span>`,
    `<span class="gantt-item-meta"> · ${escapeTimelineContent(ganttItemMeta(span))}</span>`,
  ].join("");
}

export function ganttItemTitle(span: TraceSpan): string {
  return [
    span.label,
    `${laneLabels[span.lane]} · ${formatSpanStatus(span.status)} · ${formatSpanDuration(span)}`,
    ganttIdentifierLine(span),
    span.summary,
  ]
    .filter(Boolean)
    .join("\n");
}

export function ganttItemMeta(span: TraceSpan): string {
  const request = networkRequestFromPayload(span.payload);
  if (request) {
    return [formatNetworkStatus(request), formatDuration(request.durationMs)].join(" · ");
  }

  return [formatSpanStatus(span.status), formatSpanDuration(span)].join(" · ");
}

export function ganttIdentifierLine(span: TraceSpan): string {
  return [
    span.traceId ? `trace ${span.traceId}` : "",
    span.sessionId ? `session ${span.sessionId}` : "",
    span.turnId ? `turn ${span.turnId}` : "",
    span.toolCallId ? `tool ${span.toolCallId}` : "",
    span.spanId ? `span ${span.spanId}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export function networkRequestFromPayload(payload: unknown): NetworkRequestRecord | null {
  if (!isPlainObject(payload)) return null;
  if (typeof payload.id !== "string") return null;
  if (typeof payload.startedAt !== "string") return null;
  if (typeof payload.method !== "string") return null;
  if (typeof payload.url !== "string") return null;
  if (typeof payload.status !== "string") return null;
  return payload as unknown as NetworkRequestRecord;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ganttOptions(isFullscreen: boolean): TimelineOptions {
  return {
    stack: true,
    autoResize: true,
    selectable: true,
    showCurrentTime: false,
    horizontalScroll: true,
    verticalScroll: true,
    zoomKey: "ctrlKey",
    orientation: { axis: "top", item: isFullscreen ? "top" : "bottom" },
    margin: { item: { horizontal: 8, vertical: 8 }, axis: 12 },
    groupHeightMode: "fitItems",
    height: isFullscreen ? "100%" : undefined,
    minHeight: isFullscreen ? "0" : "320px",
    maxHeight: isFullscreen ? undefined : "560px",
  };
}

export function escapeTimelineContent(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
