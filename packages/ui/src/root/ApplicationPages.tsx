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
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { ZCodeAgentWorkspaceTarget } from "@zcode/services";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { logger } from "@/logger.js";

export interface ApplicationPage {
  id: string;
  label: string;
  Icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  standalone?: boolean;
  render: (context: ApplicationPageContext) => ReactNode;
}

export interface ApplicationPageContext {
  /** Close the current page without reloading or changing the native workspace. */
  close(): void;
  workspace?: ZCodeAgentWorkspaceTarget;
  rpcReady: boolean;
  /** Native navigation only; never sends input or grants execution. */
  openConversation?(session: string, draft?: string): Promise<void>;
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
) {
  const existing = readV4ComposerDraft(path, identity, session);
  if (existing?.text.trim() && existing.text !== text)
    throw new Error("conversation_draft_conflict");
  persistV4ComposerDraft(path, identity, session, { ...existing, text });
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
    async (session: string, draft?: string) => {
      if (!services.projectService) throw new Error("conversation_navigation_unavailable");
      const target = await services.projectService.prepareSession();
      if (draft)
        preserveConversationInputDraft(
          target.workspacePath,
          target.workspaceIdentity,
          session,
          draft,
        );
      tabs.getState().addTab(target.workspacePath, { workspacePurpose: "conversation" });
      setActiveTaskId(target.workspacePath, session, target.workspaceIdentity);
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
  return (
    <ServiceProvider services={services}>
      {render({
        close: () => onNavigate?.(),
        rpcReady: Boolean(workspace) && resolution.rpcReady,
        openConversation: async (session, draft) => {
          await openConversation(session, draft);
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
  const { intl } = useZCodeIntl();
  const [selected, setSelected] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const page = pages.find((candidate) => candidate.id === selected);

  useEffect(() => {
    if (selected && !page) setSelected(null);
  }, [selected, page]);
  useEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected, generation]);

  const close = () => {
    logger.info("application.page.closed", { pageId: selected });
    setSelected(null);
    (returnFocus.current?.isConnected ? returnFocus.current : trigger.current)?.focus();
  };
  // 工具栏目标由装配明确指定，避免业务页面注册顺序改变入口。
  const first = headerPageId ? pages.find((item) => item.id === headerPageId) : pages[0];
  const openPage = (id: string) => {
    if (!pages.some((item) => item.id === id)) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected(id);
    logger.info("application.page.opened", { pageId: id });
  };
  const action = first ? (
    <ControlHintTooltip title={first.label} side="bottom">
      <Button
        ref={trigger}
        variant="ghost"
        size={first.Icon ? "icon-md" : "default"}
        className="text-foreground hover:bg-hover hover:text-foreground max-sm:min-h-11 max-sm:min-w-11 [app-region:no-drag]"
        aria-label={first.label}
        onClick={() => {
          returnFocus.current = trigger.current;
          setSelected(first.id);
          logger.info("application.page.opened", { pageId: first.id });
        }}
      >
        {first.Icon ? <first.Icon className="size-4" aria-hidden={true} /> : first.label}
      </Button>
    </ControlHintTooltip>
  ) : null;
  return (
    <ApplicationPageNavigationContext value={openPage}>
      <ApplicationPageActionContext value={action}>
        {children}

        <Dialog
          open={Boolean(page)}
          onOpenChange={(open) => {
            if (!open) close();
          }}
        >
          {page && (
            <DialogContent
              showCloseButton={false}
              aria-describedby={undefined}
              className="inset-0 top-0 left-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 bg-background p-0"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                (returnFocus.current?.isConnected ? returnFocus.current : trigger.current)?.focus();
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
                    {pages
                      .filter((item) => !item.standalone)
                      .map((item) => (
                        <Button
                          key={item.id}
                          variant="ghost"
                          aria-pressed={selected === item.id}
                          className="aria-pressed:bg-selected"
                          onClick={() => {
                            setSelected(item.id);
                            logger.info("application.page.selected", {
                              pageId: item.id,
                            });
                          }}
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
