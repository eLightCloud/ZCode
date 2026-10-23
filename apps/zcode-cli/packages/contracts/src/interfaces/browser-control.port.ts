import type { TraceContext } from "../tracing/tracer.js";

import type { BrowserCommand } from "./browser-commands.js";

export type {
  BrowserCommand,
  BrowserCommandMethod,
  BrowserKeyModifier,
  BrowserMouseButton,
  BrowserPlaywrightAction,
  BrowserPlaywrightLocatorOperation,
  BrowserPlaywrightModifier,
  BrowserPoint,
  BrowserRecordingAction,
  BrowserRecordingOptions,
} from "./browser-commands.js";

/**
 * BrowserControlPort —— agent 侧浏览器控制端口。
 *
 * browser-client 库把 agent.browsers.* 的每个调用构造成 BrowserCommand，经此端口执行；
 * 实现（ProtocolBrowserControlBroker）把它翻译成 ZCode Protocol 的
 * interaction/browserExecute 反向请求，由 app（host→main WebContentsView/CDP）执行。
 *
 * 类型说明：BrowserCommand/BrowserCommandResult 与 @zcode/shared 的 browser-use 契约同构。
 * 此处定义结构镜像（不 import @zcode/shared，避免 agent contracts 的 zod v3 与 shared zod v4
 * 跨包耦合）；协议边界用 shared 的 zod schema 做运行时校验，两侧一致性由 round-trip 测保证。
 */

/** Playwright 是 Tab API 层，不是 backend family。 */
export type BrowserBackendType = "iab" | "extension" | "cdp";

export interface BrowserCapabilityDescriptor {
  id: string;
  description: string;
}

/**
 * 完成握手且真实可达的 backend descriptor；id 是运行时 connection identity，不能用 type 代替。
 */
export interface BrowserBackendDescriptor {
  id: string;
  generation: number;
  type: BrowserBackendType;
  name: string;
  capabilities: {
    browser?: BrowserCapabilityDescriptor[];
    tab?: BrowserCapabilityDescriptor[];
  };
  apiSupportOverrides?: Record<string, boolean>;
  metadata?: Record<string, string>;
}

/** ZCode Protocol 使用包装结果；BrowserControlPort.list 会解包并直接返回 browsers。 */
export interface BrowserBackendListResult {
  browsers: BrowserBackendDescriptor[];
}

export type BrowserClientMode = "desktop-continuous" | "web-remote-replayable";

export type BrowserSessionContextKind = "live" | "cached";

/** 与 Desktop 自由尺寸视口保持同一组 CSS px 边界。 */
export const BROWSER_VIEWPORT_LIMITS = {
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 320,
  maxHeight: 2160,
} as const;

export interface BrowserViewportSize {
  width: number;
  height: number;
}

/** backend discovery 使用的完整 workspace/session 隔离上下文。 */
export interface BrowserDiscoveryContext {
  requestId: string;
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
  turnId?: string;
  clientMode: BrowserClientMode;
  sessionContext: BrowserSessionContextKind;
}

/** execute 比 discovery 多一个精确 runtime browser identity。 */
export interface BrowserSessionContext extends BrowserDiscoveryContext {
  browserId: string;
  browserGeneration: number;
}

export type BrowserErrorCode =
  | "backend_unavailable"
  | "capability_unsupported"
  | "duplicate_request_id"
  | "ref_not_found"
  | "navigation_blocked"
  | "timeout"
  | "renderer_unreachable"
  | "cancelled"
  | "execution_error";

export interface BrowserPageState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  scrollX?: number;
  scrollY?: number;
  viewportWidth?: number;
  viewportHeight?: number;
}

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  selector: string;
  xpath: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  parentRef?: string;
  framePath?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshotDomNode {
  tag: string;
  depth: number;
  inViewport: boolean;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: BrowserSnapshotElement[];
  truncated: boolean;
  dom?: BrowserSnapshotDomNode[];
  domTruncated?: boolean;
}

/** 受控 tab 摘要（list 命令返回）；与 @zcode/shared 的 browserTabSummarySchema 镜像同步。 */
export interface BrowserTabSummary {
  tabId: string;
  url: string;
  title: string;
  /** guest 当前真实 CSS viewport；normal/free-size 均必须返回。 */
  viewport: BrowserViewportSize;
  /** 当前可见/激活的内置浏览器 tab；agent 用它优先读取用户正在看的页面。 */
  active?: boolean;
  lifecycle?: "active" | "deliverable" | "handoff";
}

export interface BrowserUserTabInfo {
  id: string;
  lastOpened?: string;
  tabGroup?: string;
  title?: string;
  url?: string;
}

export interface BrowserResponseMeta {
  browserUse: true;
  backendType: BrowserBackendType;
  browserId: string;
  browserGeneration: number;
  openTabIds: string[];
  tabId?: string;
  currentUrl?: string;
  lifecycle?: "active" | "deliverable" | "handoff" | "closed";
}

/** JS 弹窗信息（getDialog 返回）。 */
export interface BrowserDialog {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

export interface BrowserRecordingArtifact {
  path: string;
  mimeType: "video/webm";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

export interface BrowserRecordingJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "failed" | "cancelled";
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingArtifact;
  error?: string;
}

export interface BrowserCommandResult {
  ok: boolean;
  state?: BrowserPageState;
  snapshot?: BrowserSnapshot;
  image?: { base64: string; mimeType: "image/png" };
  /** list 命令返回：当前会话窗口下所有受控 tab 的摘要。 */
  tabs?: BrowserTabSummary[];
  userTabs?: BrowserUserTabInfo[];
  tab?: BrowserTabSummary;
  /** evaluate 返回：页面表达式的可 JSON 序列化结果。 */
  value?: unknown;
  /** elementInfo 返回：坐标命中元素的信息（未命中则省略）。 */
  element?: BrowserSnapshotElement;
  /** getDialog 返回：当前 JS 弹窗信息；无弹窗时为 null。 */
  dialog?: BrowserDialog | null;
  recording?: BrowserRecordingJob;
  error?: { code: BrowserErrorCode; message: string; sideEffect?: "none" | "uncertain" };
  meta?: BrowserResponseMeta;
  elapsedMs: number;
}

export interface BrowserControlExecuteInput {
  /** 精确 runtime backend id；不能只传 iab/extension/cdp family。 */
  browserId: string;
  browserGeneration: number;
  sessionId: string;
  turnId?: string;
  command: BrowserCommand;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

export interface BrowserControlListInput {
  sessionId: string;
  turnId?: string;
  traceContext?: TraceContext;
  signal?: AbortSignal;
}

/** 子会话 Browser 请求的 tab 归属：子会话自己（dwf 子代理）或父会话（core Agent 子代理）。 */
export type BrowserChildSessionTabOwner = "child" | "parent";

export interface BrowserControlPort {
  /** 只返回完成握手且当前 context 可达的 backend，不允许伪造 stub。 */
  list(input: BrowserControlListInput): Promise<BrowserBackendDescriptor[]>;
  execute(input: BrowserControlExecuteInput): Promise<BrowserCommandResult>;
  /** turn 结束时取消该 turn 尚未完成的 IAB 请求，不跨 session 清 tab。 */
  turnEnded?(input: BrowserControlListInput): Promise<void>;
  /** session 关闭时释放 browser guest、pending request 与 lease。 */
  closeSession?(input: BrowserControlListInput): Promise<void>;
  /**
   * 为一个客户端不认识的子会话派生端口：workspace / clientMode 按 parentSessionId 的会话解析。
   *
   * - `tabOwner: "child"`（默认，dwf 子代理）：tab 归属是子会话自己的 sessionId；派生端口的
   *   closeSession 连 tab 一起关，并结束这份登记。
   * - `tabOwner: "parent"`（core Agent 子代理）：下发的 sessionId 换成父会话，子代理与当前对话共用同一组
   *   tab（桌面据此展开面板、tabs.list 列出对话全部 tab）；派生端口的 turnEnded / closeSession 不向
   *   桌面发生命周期，tab 交给父会话自己的生命周期管理，closeSession 只结束登记。
   *
   * 登记结束后该子会话的请求与从未登记的一样被拒。
   *
   * 缺席表示实现不按客户端会话校验 sessionId（如 CLI headless CDP），子会话直接用本端口。
   * 见 apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md「Subagent sessions」。
   */
  forChildSession?(input: {
    childSessionId: string;
    parentSessionId: string;
    tabOwner?: BrowserChildSessionTabOwner;
  }): BrowserControlPort;
}
