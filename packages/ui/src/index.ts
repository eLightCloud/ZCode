export { useFileDownload } from "./hooks/useFileDownload.js";
export { FileContentPreview } from "./previewPaneContent.js";
export { App } from "./App.js";
export { AppErrorBoundary, ScopedErrorBoundary } from "./ErrorBoundary.js";
export type { ScopedErrorBoundaryVariant } from "./ErrorBoundary.js";
export { Button, buttonVariants } from "./components/ui/button.js";
export { Popover, PopoverTrigger, PopoverContent } from "./components/ui/popover.js";
export { Tooltip, TooltipTrigger, TooltipContent } from "./components/ui/tooltip.js";
export { DesktopWindowFrame } from "./DesktopWindowFrame.js";
export { WebRemoteControlDialog } from "@/web-remote-control/index.js";
export {
  WebRemoteControlFeatureProvider,
  useWebRemoteControlFeatureEnabled,
} from "./WebRemoteControlFeatureProvider.js";
export {
  AssistantCodeCommentFeatureProvider,
  useAssistantCodeCommentFeatureEnabled,
} from "./AssistantCodeCommentFeatureProvider.js";
export { PluginStoreCatalogRow } from "./settings/PluginStoreCatalogRow.js";
export { Root } from "./Root.js";
export { UpdateStatusWindowRoot } from "./UpdateStatusWindowRoot.js";
export type { WebRemoteControlTerminalTransportState } from "./root/types.js";
export { setWebRemoteControlTerminalTransportState } from "./webRemoteControlTerminalTransportState.js";
export { ConfirmDialogHost } from "./ConfirmDialog.js";
export { Terminal } from "./Terminal.js";
export { GitGraphPane } from "./git-graph/GitGraphPane.js";
export { layoutGitGraph } from "./git-graph/layout.js";
export type {
  GitGraphCommit,
  GitGraphLayout,
  GitGraphLayoutEdge,
  GitGraphLayoutOptions,
  GitGraphLayoutRow,
  GitGraphRef,
  GitGraphRefKind,
} from "./git-graph/layout.js";
export { SSHDialog, RemoteConnectionDialog } from "./SSHDialog.js";
export { useTheme } from "./useTheme.js";
export type { Theme } from "./useTheme.js";
export { useTestActions } from "./test-actions.js";
export type { TestActions } from "./test-actions.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export type { ApplicationPluginStoreSection } from "./root/ApplicationPluginStoreSection.js";
export type { ApplicationPage, ApplicationPageContext } from "./root/ApplicationPages.js";
export { useApplicationPageNavigation } from "./root/ApplicationPages.js";
export type {
  ApplicationSettings,
  ApplicationSettingsSection,
  ApplicationModelEntry,
  ApplicationSettingsNavigation,
} from "./root/ApplicationSettings.js";
export {
  Package as SettingsModelIcon,
  ShieldCheck as SettingsAccountIcon,
  Users as SettingsMembersIcon,
} from "lucide-react";
// 可信应用装配与原生 UI 使用同一图标依赖，不要求外部源码复制私有组件。
export {
  Archive,
  ArrowLeft,
  Paperclip,
  Cloud,
  CloudCheck,
  CloudUpload,
  CloudAlert,
  CloudOff,
  RefreshCw,
  Info,
  SearchX,
  AlertCircle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Search,
  SlidersHorizontal,
  List,
  LayoutGrid,
  X,
  Download,
  Eye,
  Ellipsis,
  Link,
  Filter,
  Layers,
  ReceiptText,
  Wallet,
} from "lucide-react";
export type { ZCodeState } from "./store/index.js";
export {
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "./store/remoteWorkspaceSessionStore.js";
export {
  REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
  createRemoteWorkspaceDisconnectedError,
} from "./lib/remoteWorkspaceServiceError.js";
export {
  getSourceSettingsServices,
  registerSourceSettingsServices,
  useSourceSettingsServices,
} from "./store/sourceSettingsServiceStore.js";

// Hooks —— 统一的服务和平台操作访问层
export {
  ServiceProvider,
  useServices,
  useOptionalServices,
  useWorkspaceServices,
  PlatformProvider,
  usePlatform,
  useSelectDirectory,
  useConnectRemote,
  useReaddir,
  useSystemInfo,
  useIntranetProbe,
  useTerminal,
  useSettings,
  useRecentProjects,
  useConfirmDialog,
  useCredentials,
  useAuthToken,
  useGitRepository,
  useGitActions,
} from "./hooks/index.js";

export { ZCodeIntlProvider, useZCodeIntl, LocaleSwitcher } from "./i18n/index.js";
export { ResourceManagerApp } from "./resource-manager/ResourceManagerApp.js";
export type {
  ResourceManagerAppProps,
  ResourceManagerTab,
} from "./resource-manager/ResourceManagerApp.js";
export type { IntlInstance } from "./i18n/index.js";
export {
  FileDisplayInline,
  FileDisplayIcon,
  createFileDisplayDom,
  getFileDisplayPath,
  resolveFileDisplayDescriptor,
  setDefaultFileDisplayBasePath,
} from "./lib/fileDisplay.js";
export type { FileDisplayDescriptor, FileDisplayOptions } from "./lib/fileDisplay.js";
export { playTaskNotificationSound } from "./lib/taskNotificationSound.js";
export { installDocumentHiddenMotionPause } from "./lib/documentHiddenMotionPause.js";
export {
  applyUiFontSizePx,
  loadUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
} from "./lib/uiFontSize.js";
export { reportUiLaunchToInput } from "./lib/uiPerfArmsTelemetry.js";
export {
  RendererUserActionTelemetry,
  runUserAction,
  runUserActionAsync,
  setUserActionTelemetry,
  startUserAction,
} from "./lib/userActionTelemetry.js";
export {
  CORE_USER_ACTION_FEATURES,
  SETTINGS_USER_ACTION_FEATURES,
  USER_ACTION_CATALOG,
} from "./lib/userActionTraceCatalog.js";
export { setReactErrorArmsReporter } from "./lib/reactErrorArmsTelemetry.js";
export { recordArmsCustomEventForE2E } from "./lib/armsCustomEventObservability.js";
export { generateMobileDeviceFingerprint, setStreamClientId } from "./lib/streamClientId.js";
export { GlobalDatabaseStartupLoading } from "./root/GlobalDatabaseStartupLoading.js";

export { LocalTtftObserver, setLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";
export { ensurePendingTaskDraft } from "@/v4/composer/composerDraftStore.js";

export {
  ApplicationBrandProvider,
  ApplicationBrandImage,
  useApplicationBrand,
  type ApplicationBrand,
} from "./application-brand.js";
export { logger } from "./logger.js";

export type {
  ApplicationPeripherals,
  ApplicationShareCandidate,
  ApplicationConversationContext,
} from "./root/ApplicationPeripherals.js";
export { ApplicationDialog } from "./root/ApplicationDialog.js";
export {
  ConversationHistory,
  type ConversationHistoryLabels,
} from "./components/ConversationHistory.js";

export {
  useConversationHistory,
  ConversationSidebar,
  ConversationSaveIndicator,
  ConversationConflict,
} from "./conversation-workbench/contract.js";

export { preserveConversationInputDraft } from "./root/ApplicationPages.js";
