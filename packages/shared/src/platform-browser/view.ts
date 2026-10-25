import type { BrowserViewportSize } from "../browser-use/command-metadata.js";

/** Main 将一次能够定位真实 tab 的 browser-use 操作投递给其 origin renderer。 */
export interface BrowserViewOperationPayload {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  tabId: string;
  browserId: string;
  browserGeneration: number;
  /** 当前模型命令会打开、激活或改变 Browser 布局，renderer 应重建 resize observation baseline。 */
  resetsResizeBaseline?: boolean;
}

export type BrowserTabResidencyState =
  | "live-visible"
  | "live-background"
  | "suspend-pending"
  | "suspended"
  | "restoring";

/** 仅用于创建尚未提交首个 navigation entry 的 residency restore guest。 */
export const BROWSER_VIEW_RESTORE_BOOTSTRAP_URL = "zcode-browser-restore://pending";

/** Renderer 上报 tab shell 的展示事实；windowId 必须由 main 绑定可信 IPC sender。 */
export interface BrowserViewResidencyReportPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  selected: boolean;
  visible: boolean;
  currentTask: boolean;
  loading: boolean;
  restoreUrl?: string | null;
  title?: string | null;
  faviconUrl?: string | null;
}

export interface BrowserViewResidencyTransitionPayload {
  tabId: string;
  workspaceKey: string;
  remoteSessionId: string | undefined;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  generation: number;
  residency: Extract<
    BrowserTabResidencyState,
    "live-visible" | "live-background" | "suspended" | "restoring"
  >;
}

export interface BrowserViewCloseTabRequest {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
}

export const LOCAL_MEDIA_PREVIEW_SCHEME = "zcode-media";

export function buildLocalMediaPreviewUrl(path: string): string {
  const url = new URL(`${LOCAL_MEDIA_PREVIEW_SCHEME}://local/preview`);
  url.searchParams.set("path", path);
  return url.toString();
}

/**
 * main→renderer 的关闭通知。
 *
 * 旧 payload 只有 tabId，renderer 只能在“当前活跃 workspace”的 side pane 状态里查找；
 * 用户已切到别的 workspace 时通知会被静默丢弃，原 workspace 的持久化状态里留下关不掉的幽灵 tab。
 * 带上 owner scope 后，renderer 可以直接定位到对应 workspace 的 side pane 内存删除该 tab。
 * scope 字段可缺省：recovery-orphan 等内部路径只有 tabId，renderer 此时退回“仅当前 workspace”语义。
 */
export interface BrowserViewCloseTabNotification {
  tabId: string;
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  reason?: "recovery-orphan";
}

/** 跨重启先恢复 logical shell；renderer 初始不得一次 mount 全部 guest。 */
export interface BrowserViewRestoredTabShell {
  tabId: string;
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId: string;
  browserId: string;
  browserGeneration: number;
  origin: "agent" | "user";
  restoreUrl: string | null;
  title: string | null;
  faviconUrl: string | null;
  openedAt: number;
  lastSelectedAt: number | null;
}

export interface BrowserViewRestoreTabsRequest {
  workspaceKey: string;
  remoteSessionId?: string;
  sessionId?: string;
}

/** Main 将 Agent viewport 变更定向投递给目标 tab 的 origin renderer。 */
export interface BrowserViewViewportChangedPayload extends BrowserViewOperationPayload {
  viewport: BrowserViewportSize | null;
}

// 旧默认预算 1500ms 在慢机器或后台窗口中不足以等待连续稳定帧；main 与 renderer
// 共用这个默认值，并由 prepare payload 传递实际覆盖值，避免两端 deadline 再次漂移。
export const BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS = 3_000;

/** 截图/录制握手对 renderer 预览比例的瞬时要求；缺失时沿用用户当前预览。 */
export type BrowserViewSurfaceScaleMode = "current" | "unscaled";

/** Main 请求 owner renderer 在截图前准备后台 guest 合成表面。 */
export interface BrowserViewScreenshotSurfacePreparePayload extends BrowserViewOperationPayload {
  requestId: string;
  webContentsId: number;
  viewport: BrowserViewportSize;
  /** 自然 viewport 不使用 metrics 的 guest 布局补偿；缺失时保持原仿真行为（含录制）。 */
  viewportMode?: "natural" | "emulated";
  /** `unscaled` 只在 lease 生命周期内强制真实 100% surface，不写回用户的 Fit/固定比例。 */
  surfaceScaleMode?: BrowserViewSurfaceScaleMode;
  /** Main 当前实际使用的 prepare 超时；旧 payload 缺失时 renderer 回退到共享默认值。 */
  timeoutMs?: number;
}

/** Owner renderer 确认目标 guest 的逻辑 viewport 与原生预览 surface 比例均已稳定。 */
export interface BrowserViewScreenshotSurfaceReadyPayload extends BrowserViewScreenshotSurfacePreparePayload {
  surfaceScale: number;
}

/** Main 通知 owner renderer 释放临时后台截图合成表面。 */
export type BrowserViewScreenshotSurfaceReleasePayload = Omit<
  BrowserViewScreenshotSurfacePreparePayload,
  "viewport" | "viewportMode" | "surfaceScaleMode" | "timeoutMs"
>;

export type BrowserGuestAttachRejectReason =
  | "not-found"
  | "destroyed"
  | "not-webview"
  | "closed"
  | "window-mismatch"
  | "workspace-mismatch"
  | "session-mismatch"
  | "remote-session-mismatch"
  | "residency-suspended"
  | "residency-generation-mismatch";

/** Renderer 上报 guest 后 main 返回的绑定结果；拒绝不能再被伪装成无返回的 ready timeout。 */
export type BrowserGuestAttachResult =
  | { ok: true; guestGeneration: number }
  | { ok: false; reason: BrowserGuestAttachRejectReason; recoveryRequested: boolean };
