import "vis-timeline/styles/vis-timeline-graph2d.min.css";

// 同一语义的唯一数据定义；原公开入口继续转出，内部依赖不反向指向聚合入口。
export interface SourceInputs {
  projectId: string;
  logDir: string;
  eventPath: string;
  dbPath: string;
  sessionId: string;
}

export interface ObservationEventState {
  connected: boolean;
  error: string | null;
  lastChangeAt?: string;
  watchedPathCount: number;
}
