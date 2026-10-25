export type ChromeBrowserDataImportError =
  | "chrome_profile_not_found"
  | "chrome_profile_ambiguous"
  | "chrome_executable_not_found"
  | "chrome_cookie_access_denied"
  | "chrome_cookie_elevation_required"
  | "chrome_cookie_elevation_cancelled"
  | "chrome_cookie_helper_verification_failed"
  | "chrome_cookie_app_bound_decryption_failed"
  | "chrome_cookie_protection_unsupported"
  | "chrome_profile_locked"
  | "chrome_local_storage_import_failed"
  | "chrome_import_not_supported"
  | "chrome_browser_data_import_unavailable"
  | "chrome_data_import_failed"
  | "chrome_default_profile_not_found";

export interface ChromeBrowserDataImportOptions {
  /** Windows App-Bound Cookie 只能在本次显式确认后触发 UAC；不得持久化为全局授权。 */
  allowElevatedChromeDecryption?: boolean;
}

/** Chrome 浏览器数据导入只返回数量和状态；Cookie/LocalStorage 值和解密材料不得跨进程。 */
export interface ChromeBrowserDataImportResult {
  success: boolean;
  cookies: {
    imported: number;
    skipped: number;
    failed: number;
  };
  localStorage: {
    originsImported: number;
    entriesImported: number;
    originsSkipped: number;
    originsFailed: number;
    error?: ChromeBrowserDataImportError;
  };
  /** 部分成功时保留可操作问题；不得包含 Profile 绝对路径或站点数据。 */
  issues?: ChromeBrowserDataImportError[];
  error?: ChromeBrowserDataImportError;
}

export interface EmbeddedBrowserDataClearResult {
  success: boolean;
  error?: string;
}

export interface EmbeddedBrowserOpenUrlRequest {
  url: string;
  disposition: "default" | "foreground-tab" | "background-tab" | "new-window" | "other";
  /** 触发 popup 的 browser-use tab 归属；旧版事件缺失时由 renderer 按当前 scope 兼容处理。 */
  workspaceKey?: string;
  remoteSessionId?: string;
  sessionId?: string;
  browserId?: string;
  browserGeneration?: number;
  sourceTabId?: string;
}

export interface EmbeddedBrowserPermissionDeviceOption {
  deviceId: string;
  name?: string;
  vendorId?: number;
  productId?: number;
  serialNumber?: string;
}

export interface EmbeddedBrowserPermissionScreenOption {
  sourceId: string;
  name: string;
  /** 源类型：整个屏幕 / 窗口，由 main 按 desktopCapturer source id 前缀判定。 */
  kind: "screen" | "window";
  thumbnailDataUrl?: string;
}

/** Main → Renderer 的内置浏览器权限弹窗请求；kind 决定 renderer 渲染哪类弹窗。 */
export type EmbeddedBrowserPermissionPromptEvent =
  | {
      requestId: string;
      kind: "permission";
      origin: string;
      permission: string;
      mediaTypes?: string[];
      /** 发起请求的 guest webContents id；renderer 据此只在归属 tab 渲染，
       *  避免后台 tab 的请求显示在当前 tab 造成误批准。 */
      guestWebContentsId?: number;
    }
  | {
      requestId: string;
      kind: "screen-share";
      origin: string;
      screens: EmbeddedBrowserPermissionScreenOption[];
      /** 屏幕共享无 tab 锚定语义，恒缺省（兜底渲染）。 */
      guestWebContentsId?: number;
    }
  | {
      requestId: string;
      kind: "device";
      origin: string;
      /** select-hid-device / select-usb-device / select-serial-port / select-bluetooth-device */
      permission: string;
      devices: EmbeddedBrowserPermissionDeviceOption[];
      /** 发起请求的 guest webContents id（serial/蓝牙可取到；hid/usb 受 frame 限制
       *  缺省，renderer 兜底渲染）。 */
      guestWebContentsId?: number;
    };

export type EmbeddedBrowserPermissionResolution =
  | { action: "allow-always" }
  | { action: "allow-session" }
  | { action: "block-always" }
  | { action: "dismiss" }
  | { action: "share-screen"; sourceId: string }
  | { action: "select-device"; deviceId: string }
  | { action: "cancel" };

export interface EmbeddedBrowserPermissionResolveRequest {
  requestId: string;
  resolution: EmbeddedBrowserPermissionResolution;
}

export type EmbeddedBrowserSitePermissionsSnapshot = Record<
  string,
  Record<string, "allow" | "deny">
>;

export interface EmbeddedBrowserSitePermissionUpdateRequest {
  origin: string;
  permission: string;
  /** "ask" 表示删除该条记录，回到每次询问。 */
  state: "allow" | "deny" | "ask";
}

export interface EmbeddedBrowserSitePermissionResetRequest {
  origin: string;
}
