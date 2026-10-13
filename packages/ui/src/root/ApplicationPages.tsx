import {
  createContext,
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
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import type { ZCodeAgentWorkspaceTarget } from "@zcode/services";
import { logger } from "@/logger.js";

export interface ApplicationPage {
  id: string;
  label: string;
  Icon?: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  render: (context: ApplicationPageContext) => ReactNode;
}

export interface ApplicationPageContext {
  workspace?: ZCodeAgentWorkspaceTarget;
  rpcReady: boolean;
}

const ApplicationPageActionContext = createContext<ReactNode>(null);

export function useHasApplicationPages() {
  return useContext(ApplicationPageActionContext) !== null;
}

export function ApplicationPageHeaderAction() {
  return useContext(ApplicationPageActionContext);
}

export function ApplicationPageContent({
  render,
}: Pick<ApplicationPage, "render">) {
  const active = useTabStore((state) =>
    state.tabs.find((tab) => tab.id === state.activeTabId),
  );
  const workspace = active && isWorkspaceTab(active) ? active : undefined;
  const resolution = useWorkspaceServicesResolution(
    workspace?.workspacePath,
    workspace?.remoteSessionId,
    workspace?.workspaceIdentity,
    workspace?.remoteTarget,
  );
  return (
    <ServiceProvider services={resolution.services}>
      {render({
        rpcReady: Boolean(workspace) && resolution.rpcReady,
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
  children,
}: {
  pages: readonly ApplicationPage[];
  children?: ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const [selected, setSelected] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
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
    trigger.current?.focus();
  };
  const first = pages[0];
  const action = first ? (
    <ControlHintTooltip title={first.label} side="bottom">
      <Button
        ref={trigger}
        variant="ghost"
        size={first.Icon ? "icon-md" : "default"}
        className="text-foreground hover:bg-hover hover:text-foreground max-sm:min-h-11 max-sm:min-w-11 [app-region:no-drag]"
        aria-label={first.label}
        onClick={() => {
          setSelected(first.id);
          logger.info("application.page.opened", { pageId: first.id });
        }}
      >
        {first.Icon ? (
          <first.Icon className="size-4" aria-hidden={true} />
        ) : (
          first.label
        )}
      </Button>
    </ControlHintTooltip>
  ) : null;
  return (
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
              trigger.current?.focus();
            }}
          >
            {/* 全页覆盖层要避开 macOS 原生窗控，并为 Windows/Linux 保留可操作窗控。 */}
            <DesktopOverlayWindowControls />
            <header className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border bg-background p-3 platform-mac-desktop:pl-24 platform-windows-desktop:pr-36 platform-linux-desktop:pr-36">
              <DialogTitle ref={heading} tabIndex={-1} className="sr-only">
                {page.label}
              </DialogTitle>
              <nav
                className="flex flex-wrap gap-2"
                aria-label={intl.formatMessage({
                  id: "applicationPages.navigation",
                })}
              >
                {pages.map((item) => (
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
            <div
              className="min-h-0 flex-1 overflow-auto"
              key={`${page.id}:${generation}`}
            >
              <ScopedErrorBoundary scope={`application-page:${page.id}`}>
                <ApplicationPageContent render={page.render} />
              </ScopedErrorBoundary>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </ApplicationPageActionContext>
  );
}
