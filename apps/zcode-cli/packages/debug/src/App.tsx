import { AlertTriangle, Database, FileJson, Radio, RefreshCw } from "lucide-react";

import { useCallback, useEffect, useMemo, useState } from "react";

import "vis-timeline/styles/vis-timeline-graph2d.min.css";

import type {
  ProjectSummary,
  SourceStatus,
  TraceDetailResponse,
  TraceListResponse,
  TraceSummary,
} from "./shared";

import { emptyInputs, lastProjectStorageKey, viewLabels } from "./debug-view-config.js";

import type { DebugView, ObservationEventState, SourceInputs } from "./debug-view-config.js";

import { formatTime, viewFromHash } from "./debug-formatters.js";

import {
  buildQuery,
  fetchJson,
  useDelayedVisible,
  useNetworkCapture,
  useObservationEvents,
} from "./debug-data-hooks.js";

import { mergeNetworkSpans } from "./debug-network-data.js";

import { ExecutionGanttPanel, TimelinePanel } from "./debug-execution-panels.js";

import { CachePanel, ContextPanel, GapsPanel } from "./debug-context-panels.js";

import { NetworkPage } from "./debug-network-panels.js";

export function App() {
  const [inputs, setInputs] = useState<SourceInputs>(emptyInputs);
  const [traceId, setTraceId] = useState("");
  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sources, setSources] = useState<SourceStatus[]>([]);
  const [detail, setDetail] = useState<TraceDetailResponse | null>(null);
  const [view, setView] = useState<DebugView>(() => viewFromHash(window.location.hash));
  const [networkFilter, setNetworkFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const network = useNetworkCapture();

  const query = useMemo(() => buildQuery(inputs), [inputs]);
  const spans = useMemo(
    () => mergeNetworkSpans(detail?.spans ?? [], network.requests, traceId),
    [detail?.spans, network.requests, traceId],
  );
  const setDebugView = useCallback((nextView: DebugView) => {
    setView(nextView);
    window.history.replaceState(null, "", `#${nextView}`);
  }, []);
  const selectTrace = useCallback((nextTraceId: string) => {
    setTraceId(nextTraceId);
  }, []);

  const loadTraces = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchJson<TraceListResponse>(`/api/traces${query}`);
      setTraces(response.traces);
      setProjects(response.projects);
      setSources(response.sources);

      if (!inputs.projectId && response.projects.length > 0) {
        const lastProjectId = window.localStorage.getItem(lastProjectStorageKey);
        const nextProjectId =
          response.projects.find((project) => project.projectId === lastProjectId)?.projectId ??
          response.projects[0]?.projectId;
        if (nextProjectId) {
          setInputs((current) => ({ ...current, projectId: nextProjectId }));
        }
      }

      const hasCurrentTrace = response.traces.some((trace) => trace.traceId === traceId);
      if (!hasCurrentTrace) {
        setTraceId(response.traces[0]?.traceId ?? "");
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, [inputs.projectId, query, traceId]);

  const loadTraceDetail = useCallback(async () => {
    if (!traceId.trim()) {
      setDetail(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const encoded = encodeURIComponent(traceId.trim());
      const response = await fetchJson<TraceDetailResponse>(`/api/traces/${encoded}${query}`);
      setDetail(response);
      setSources(response.sources);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    } finally {
      setLoading(false);
    }
  }, [query, traceId]);

  const refreshObservations = useCallback(() => {
    void loadTraces();
    void loadTraceDetail();
  }, [loadTraceDetail, loadTraces]);
  const observationEvents = useObservationEvents(query, refreshObservations);

  useEffect(() => {
    void loadTraces();
  }, [loadTraces]);

  useEffect(() => {
    void loadTraceDetail();
  }, [loadTraceDetail]);

  useEffect(() => {
    if (inputs.projectId) {
      window.localStorage.setItem(lastProjectStorageKey, inputs.projectId);
    }
  }, [inputs.projectId]);

  useEffect(() => {
    const syncViewFromHash = () => setView(viewFromHash(window.location.hash));
    window.addEventListener("hashchange", syncViewFromHash);
    return () => window.removeEventListener("hashchange", syncViewFromHash);
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>ZCode 调试台</h1>
          <p>Trace、甘特执行、网络抓包</p>
        </div>
        <div className="topbar-actions">
          <ViewTabs activeView={view} onChange={setDebugView} />
          <button
            className="icon-button"
            type="button"
            onClick={() => void loadTraces()}
            title="刷新"
          >
            <RefreshCw size={18} />
          </button>
        </div>
      </header>

      <section className="control-strip" aria-label="调试控制">
        <ProjectSelect
          projects={projects}
          value={inputs.projectId}
          onChange={(value) => {
            setInputs((current) => ({ ...current, projectId: value }));
            setTraceId("");
          }}
        />
        <TraceSelect traces={traces} value={traceId} onChange={selectTrace} />
      </section>

      {error ? (
        <div className="notice error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <SourceBar sources={sources} loading={loading} live={observationEvents} />

      {view === "trace" ? (
        <div className="workspace-grid">
          <TimelinePanel items={detail?.timeline ?? []} />
          <div className="side-stack">
            <ContextPanel
              snapshots={detail?.contextSnapshots ?? []}
              usageSnapshots={detail?.contextUsageSnapshots ?? []}
            />
            <CachePanel reports={detail?.cacheReports ?? []} />
            <GapsPanel requests={detail?.developerRequests ?? []} />
          </div>
        </div>
      ) : null}

      {view === "gantt" ? (
        <div className="gantt-page">
          <ExecutionGanttPanel spans={spans} traceId={traceId} />
        </div>
      ) : null}

      {view === "network" ? (
        <NetworkPage
          activeTraceId={traceId}
          error={network.error}
          filter={networkFilter}
          onFilterChange={setNetworkFilter}
          onTraceSelect={(nextTraceId) => {
            selectTrace(nextTraceId);
            setDebugView("gantt");
          }}
          requests={network.requests}
          status={network.status}
        />
      ) : null}
    </main>
  );
}

function ViewTabs(props: { activeView: DebugView; onChange: (view: DebugView) => void }) {
  return (
    <nav className="view-tabs" aria-label="调试视图">
      {(Object.keys(viewLabels) as DebugView[]).map((view) => (
        <button
          aria-current={props.activeView === view ? "page" : undefined}
          className={props.activeView === view ? "active" : ""}
          key={view}
          onClick={() => props.onChange(view)}
          type="button"
        >
          {viewLabels[view]}
        </button>
      ))}
    </nav>
  );
}

function ProjectSelect(props: {
  projects: ProjectSummary[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>项目</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">全部项目</option>
        {props.projects.map((project) => (
          <option key={project.projectId} value={project.projectId}>
            {project.label}（{project.sessionCount}）
          </option>
        ))}
      </select>
    </label>
  );
}

function TraceSelect(props: {
  traces: TraceSummary[];
  value: string;
  onChange: (traceId: string) => void;
}) {
  return (
    <label>
      <span>Trace</span>
      <select value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">选择 Trace</option>
        {props.traces.map((trace) => (
          <option key={trace.traceId} value={trace.traceId}>
            {trace.traceId} - {trace.firstUserMessage ?? "没有观察到用户消息"}
          </option>
        ))}
      </select>
    </label>
  );
}

function SourceBar({
  sources,
  loading,
  live,
}: {
  sources: SourceStatus[];
  loading: boolean;
  live: ObservationEventState;
}) {
  const showLoading = useDelayedVisible(loading, 180);
  return (
    <section className="source-bar" aria-label="观测数据源">
      <div className={`source-pill live ${live.connected ? "ready" : "muted"}`}>
        <Radio size={16} />
        <div>
          <strong>{live.connected ? "实时推送" : "实时重连"}</strong>
          <span>
            {live.lastChangeAt
              ? `最近更新 ${formatTime(live.lastChangeAt)}`
              : `${live.watchedPathCount} 个路径`}
          </span>
        </div>
        {live.error ? <small>{live.error}</small> : <small>SSE</small>}
      </div>
      {sources.map((source) => (
        <div className={`source-pill ${source.available ? "ready" : "muted"}`} key={source.kind}>
          {source.kind === "sqlite" ? <Database size={16} /> : <FileJson size={16} />}
          <div>
            <strong>{source.label}</strong>
            <span>{source.recordCount} 条记录</span>
          </div>
          {source.warning ? <small>{source.warning}</small> : null}
        </div>
      ))}
      <div className={`loading-dot ${showLoading ? "visible" : ""}`} aria-hidden={!showLoading}>
        加载中
      </div>
    </section>
  );
}
