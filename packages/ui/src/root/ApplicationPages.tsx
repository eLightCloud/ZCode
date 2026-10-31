import { persistV4ComposerDraft, readV4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";
import { RefreshCwIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { ScopedErrorBoundary } from "@/ErrorBoundary.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "@/hooks/useWorkspaceServices.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import {
  ApplicationPageNavigationProvider,
  useApplicationPageNavigationState,
} from "@/root/ApplicationPageNavigation.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { ZCodeAgentWorkspaceTarget } from "@zcode/services";
import type { ComposerMentionPrefill } from "@/store/zcodeSessionStoreTypes.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";
import { useApplicationSettings } from "@/root/ApplicationSettings.js";
import { ApplicationDialog } from "@/root/ApplicationDialog.js";

export interface ApplicationPage {
  id: string;
  label: string;
  Icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  standalone?: boolean;
  /** Compact modal using the shared application dialog; content owns its toolbar. */
  presentation?: "dialog";
  /** Trusted-build registration for a sidebar-mounted main-area target; ties keep registration order. */
  sidebarOrder?: number;
  render: (context: ApplicationPageContext) => ReactNode;
}

export interface ApplicationPageContext {
  /** Close the current page without reloading or changing the native workspace. */
  close(): void;
  workspace?: ZCodeAgentWorkspaceTarget;
  rpcReady: boolean;
  /** Native navigation only; never sends input or grants execution. */
  openConversation?(
    session: string,
    draft?: string,
    target?: ZCodeAgentWorkspaceTarget,
    mention?: ComposerMentionPrefill,
  ): Promise<void>;
  openSettingsSection?(id: string): void;
}

const ApplicationPageActionContext = createContext<ReactNode>(null);
const ApplicationPageNavigationContext = createContext<((id: string) => void) | undefined>(
  undefined,
);
export function useApplicationPageNavigation() {
  return useContext(ApplicationPageNavigationContext);
}

export function useHasApplicationPages() {
  return useContext(ApplicationPageActionContext) !== null;
}

export function ApplicationPageHeaderAction() {
  return useContext(ApplicationPageActionContext);
}

/** Transfers an unaccepted editor draft through the existing native per-session draft owner. */
export function preserveConversationInputDraft(
  path: string,
  identity: string | undefined,
  session: string,
  text: string,
  mention?: ComposerMentionPrefill,
) {
  const existing = readV4ComposerDraft(path, identity, session);
  if (existing?.text.trim() && existing.text !== text)
    throw new Error("conversation_draft_conflict");
  persistV4ComposerDraft(path, identity, session, {
    ...existing,
    text,
    ...(mention ? { mention } : {}),
  });
  if (readV4ComposerDraft(path, identity, session)?.text !== text)
    throw new Error("conversation_draft_unavailable");
}
export interface ApplicationConversationTarget {
  session: string;
  instanceId: string;
  scope?: string;
  draft?: string;
}

/** Navigation only, shared by application details and pages after native continuation. */
export function useNativeConversationNavigation(
  services: import("@zcode/services").IServiceAccessor,
) {
  const tabs = useTabStoreApi();
  const setActiveTaskId = useZCodeSessionStore((s) => s.setActiveTaskId);
  return useCallback(
    async (
      session: string,
      draft?: string,
      workspace?: ZCodeAgentWorkspaceTarget,
      mention?: ComposerMentionPrefill,
    ) => {
      if (!workspace && !services.projectService)
        throw new Error("conversation_navigation_unavailable");
      const target: ZCodeAgentWorkspaceTarget =
        workspace ?? (await services.projectService!.prepareSession());
      if (draft)
        preserveConversationInputDraft(
          target.workspacePath,
          target.workspaceIdentity,
          session,
          draft,
          mention,
        );
      tabs.getState().addTab(target.workspacePath, {
        workspacePurpose: "conversation",
        workspaceIdentity: target.workspaceIdentity,
        remoteSessionId: target.remoteSessionId,
      });
      setActiveTaskId(target.workspacePath, session, target.workspaceIdentity);
      logger.info("application.page.conversation_opened", { hasDraft: Boolean(draft) });
    },
    [services, tabs, setActiveTaskId],
  );
}

export function ApplicationPageContent({
  render,
  onNavigate,
  standalone,
}: Pick<ApplicationPage, "render" | "standalone"> & { onNavigate?(): void }) {
  const base = useBaseWorkspaceServices();
  const active = useTabStore((state) => state.tabs.find((tab) => tab.id === state.activeTabId));
  const workspace = active && isWorkspaceTab(active) ? active : undefined;
  const resolution = useWorkspaceServicesResolution(
    workspace?.workspacePath,
    workspace?.remoteSessionId,
    workspace?.workspaceIdentity,
    workspace?.remoteTarget,
  );
  // 独立历史页始终使用当前窗口的基础 Host，不能借活动远端 tab 操作另一执行位置。
  const services = standalone ? base : resolution.services;
  const openConversation = useNativeConversationNavigation(services);
  const settings = useApplicationSettings();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  return (
    <ServiceProvider services={services}>
      {render({
        close: () => onNavigate?.(),
        openSettingsSection: (id) => {
          if (!settings?.sections.some((section) => section.id === id)) return;
          settings.openSection(id);
          openSettingsTab();
          onNavigate?.();
          logger.info("application.page.settings_opened", { sectionId: id });
        },
        rpcReady: Boolean(workspace) && resolution.rpcReady,
        openConversation: async (session, draft, target, mention) => {
          await openConversation(session, draft, target, mention);
          onNavigate?.();
        },
        workspace: workspace
          ? {
              workspacePath: workspace.workspacePath,
              workspaceIdentity: workspace.workspaceIdentity ?? undefined,
              remoteSessionId: resolution.remoteSessionId ?? undefined,
            }
          : undefined,
      })}
    </ServiceProvider>
  );
}

/** Build-owned navigation; preserves the mounted native workspace underneath. */
export function ApplicationPages({
  pages,
  headerPageId,
  children,
}: {
  pages: readonly ApplicationPage[];
  headerPageId?: string;
  children?: ReactNode;
}) {
  return (
    <ApplicationPageNavigationProvider pages={pages}>
      <ApplicationPagesSurface pages={pages} headerPageId={headerPageId}>
        {children}
      </ApplicationPagesSurface>
    </ApplicationPageNavigationProvider>
  );
}

/** Dialog surface for build-owned pages; sidebar-registered pages are hosted by the shell. */
function ApplicationPagesSurface({
  pages,
  headerPageId,
  children,
}: {
  pages: readonly ApplicationPage[];
  headerPageId?: string;
  children?: ReactNode;
}) {
  const navigation = useApplicationPageNavigationState();
  const { intl } = useZCodeIntl();
  const [generation, setGeneration] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const selected = navigation?.selectedPageId ?? null;
  const dialogPages = navigation?.dialogPages ?? pages;
  const page = dialogPages.find((candidate) => candidate.id === selected);

  // 注册失效由导航 Provider 唯一裁决；侧栏页不在 Dialog 清单不代表失效。
  useEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected, generation]);

  const close = () => {
    navigation?.closePage();
  };
  // 工具栏目标由装配明确指定，避免业务页面注册顺序改变入口。
  const first = headerPageId ? pages.find((item) => item.id === headerPageId) : dialogPages[0];
  const openPage = (id: string) => {
    navigation?.openPage(id);
  };
  const action = first ? (
    <ControlHintTooltip title={first.label} side="bottom">
      <Button
        ref={trigger}
        variant="ghost"
        size={first.Icon ? "icon-md" : "default"}
        className="text-foreground hover:bg-hover hover:text-foreground max-sm:min-h-11 max-sm:min-w-11 [app-region:no-drag]"
        aria-label={first.label}
        onClick={() => navigation?.openPage(first.id)}
      >
        {first.Icon ? <first.Icon className="size-4" aria-hidden={true} /> : first.label}
      </Button>
    </ControlHintTooltip>
  ) : null;
  return (
    <ApplicationPageNavigationContext value={openPage}>
      <ApplicationPageActionContext value={action}>
        {children}

        {page?.presentation === "dialog" && (
          <ApplicationDialog
            title={page.label}
            onClose={close}
            className="flex max-h-[min(42rem,calc(100dvh-2rem))] w-[min(40rem,calc(100vw-2rem))] flex-col overflow-hidden max-sm:max-h-[calc(100dvh-1rem)] max-sm:w-[calc(100vw-1rem)]"
          >
            <ScopedErrorBoundary scope={`application-page:${page.id}`}>
              <ApplicationPageContent
                render={page.render}
                standalone={page.standalone}
                onNavigate={close}
              />
            </ScopedErrorBoundary>
          </ApplicationDialog>
        )}
        <Dialog
          open={Boolean(page && page.presentation !== "dialog")}
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          {page && page.presentation !== "dialog" && (
            <DialogContent
              showCloseButton={false}
              aria-describedby={undefined}
              className="inset-0 top-0 left-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const settled = document.activeElement;
                if (!settled || settled === document.body || !settled.isConnected)
                  trigger.current?.focus();
              }}
            >
              {/* 全页覆盖层要避开 macOS 原生窗控，并为 Windows/Linux 保留可操作窗控。 */}
              <DesktopOverlayWindowControls />
              <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border bg-background p-3 platform-mac-desktop:pl-24 platform-windows-desktop:pr-36 platform-linux-desktop:pr-36">
                <DialogTitle ref={heading} tabIndex={-1} className="sr-only">
                  {page.label}
                </DialogTitle>
                {page.standalone ? (
                  <span className="text-ui-base font-medium">{page.label}</span>
                ) : (
                  <nav
                    className="flex flex-wrap gap-2"
                    aria-label={intl.formatMessage({
                      id: "applicationPages.navigation",
                    })}
                  >
                    {dialogPages
                      .filter((item) => !item.standalone)
                      .map((item) => (
                        <Button
                          key={item.id}
                          variant="ghost"
                          aria-pressed={selected === item.id}
                          className="aria-pressed:bg-selected"
                          onClick={() => navigation?.openPage(item.id)}
                        >
                          {item.label}
                        </Button>
                      ))}
                  </nav>
                )}
                <Button
                  variant="outline"
                  aria-label={intl.formatMessage({
                    id: "applicationPages.refresh",
                  })}
                  onClick={() => {
                    setGeneration((value) => value + 1);
                    logger.info("application.page.refreshed", {
                      pageId: page.id,
                    });
                  }}
                >
                  <RefreshCwIcon aria-hidden="true" className="size-4" />
                </Button>
                <Button variant="outline" onClick={close}>
                  {intl.formatMessage({ id: "applicationPages.close" })}
                </Button>
              </header>
              <div className="min-h-0 flex-1 overflow-auto" key={`${page.id}:${generation}`}>
                <ScopedErrorBoundary scope={`application-page:${page.id}`}>
                  <ApplicationPageContent
                    render={page.render}
                    standalone={page.standalone}
                    onNavigate={close}
                  />
                </ScopedErrorBoundary>
              </div>
            </DialogContent>
          )}
        </Dialog>
      </ApplicationPageActionContext>
    </ApplicationPageNavigationContext>
  );
}
