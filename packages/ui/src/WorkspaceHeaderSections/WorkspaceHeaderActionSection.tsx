import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { WorkspaceTerminalToggleButton } from "@/WorkspaceTerminalToggleButton.js";
import { cn } from "@/components/lib/utils.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { ApplicationPageHeaderAction } from "@/root/ApplicationPages.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";
import { MessageSquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useApplicationPeripherals } from "@/root/ApplicationPeripherals.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  activeTaskId,
  user,
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  isWebRemoteControl = false,
  isDesktop,
  isTerminalOpen,
  isSidePaneOpen,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onSelectedEditorChange,
  simplifyForNarrowRemote = false,
  hideHelpMenu = false,
  showWindowControls = false,
  useWindowsCaptionSpacing = false,
}: WorkspaceHeaderActionSectionProps) {
  const peripherals = useApplicationPeripherals();
  const { intl } = useZCodeIntl();
  const feedbackLabel = intl.formatMessage({ id: "remoteConnection.feedback" });
  return (
    <div
      className={cn(
        "flex shrink-0 items-center [app-region:no-drag]",
        // Windows header 内容区有 p-2，普通工具栏按钮 hover 只覆盖 32px 高度。
        // 标题栏按钮需要抵消这层垂直内边距，和原生窗控/右侧菜单保持同一个 48px hover 面。
        useWindowsCaptionSpacing ? "-my-2 h-12 gap-0" : "gap-0.5",
      )}
    >
      {variant === "task" ? (
        <WorkspaceEditorButtonGroup
          disabledReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteTarget={remoteTarget}
          onSelectedEditorChange={onSelectedEditorChange}
        />
      ) : null}
      {/* 分享发布接口依赖登录态；未登录时隐藏入口，避免用户打开后只能得到鉴权失败。 */}
      {activeTaskId &&
      user &&
      isDesktop !== false &&
      !isWebRemoteControl &&
      remoteTarget?.kind !== "server" ? (
        <ConversationShareMenu
          taskId={activeTaskId}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      <ApplicationPageHeaderAction />
      {peripherals && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="gap-1.5 max-sm:min-h-11 max-sm:min-w-11"
          aria-label={feedbackLabel}
          title={feedbackLabel}
          onClick={(event) => {
            event.currentTarget.focus();
            peripherals.openFeedback();
          }}
        >
          <MessageSquareIcon className="size-4" aria-hidden="true" />
          <span className="max-sm:hidden">{feedbackLabel}</span>
        </Button>
      )}
      {!simplifyForNarrowRemote ? (
        <>
          {!hideHelpMenu ? <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} /> : null}
          {/* Bugfix: 远程控制移动端头部空间过窄，终端入口在这里会和核心操作争抢宽度。 */}
          {workspaceAbsPath && (
            <WorkspaceTerminalToggleButton
              isTerminalOpen={isTerminalOpen}
              onToggleTerminal={onToggleTerminal}
              disabledReason={readOnlyReason}
              useWindowsCaptionSpacing={useWindowsCaptionSpacing}
            />
          )}
        </>
      ) : null}
      {/* 远程控制移动端只保留图标，避免 diff 数字把按钮撑宽导致标题拥挤。 */}
      {workspaceAbsPath && !isSidePaneOpen ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {showWindowControls && !isSidePaneOpen ? <DesktopWindowControls /> : null}
    </div>
  );
}
