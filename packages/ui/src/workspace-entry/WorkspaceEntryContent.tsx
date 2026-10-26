import { useEffect } from "react";
import { App } from "@/App.js";
import { RootShell } from "@/root/RootShell.js";
import { WorkspaceSettingsLayer } from "@/root/WorkspaceSettingsLayer.js";
import type { RootProps } from "@/root/types.js";
import type { CreateTaskRequest } from "@/app-shell/types.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isSettingsTab } from "@/store/tabStore.js";
import { registerBaseWorkspaceServices } from "@/store/remoteWorkspaceSessionStore.js";
import { logger } from "@/logger.js";

/** Same native shell with no attached workspace. Only explicit prepare leaves this state. */
export function WorkspaceEntryContent({ props }: { props: RootProps }) {
  const entry = props.workspaceEntry!;
  const tabs = useTabStoreApi();
  const settingsOpen = useTabStore((state) =>
    state.tabs.some((tab) => tab.id === state.activeTabId && isSettingsTab(tab)),
  );
  useEffect(() => {
    registerBaseWorkspaceServices(props.services);
    logger.info("workspace.entry", { outcome: "ready", connected: false });
  }, [props.services]);
  const prepare = (request?: CreateTaskRequest) => {
    if (entry.pending) return;
    const options = typeof request === "string" ? { provider: request } : request;
    if (options?.isCurrent?.() === false) return;
    logger.info("workspace.entry", { outcome: "preparation_requested" });
    props.applicationPeripherals?.closeConversationContent?.();
    entry.onPrepare(options);
  };
  const closeSettings = () => {
    const id = tabs.getState().activeTabId;
    if (id) tabs.getState().closeTab(id);
  };
  const unavailable = async () => {
    throw new Error("workspace_not_connected");
  };
  return (
    <RootShell>
      <div
        className="h-full"
        inert={settingsOpen || undefined}
        aria-hidden={settingsOpen || undefined}
      >
        <App
          services={props.services}
          baseFeedbackService={props.services.feedbackService}
          workspaceAbsPath=""
          workspaceEntryContent={entry.content}
          onCreateTask={prepare}
          onCreateConversationTask={() => prepare()}
          onOpenWorkspace={() => prepare()}
          onOpenFolderFromWorkspaceMenu={() => prepare()}
          onConnectRemote={unavailable}
          onSelectRemoteProject={unavailable}
          onCancelRemoteProject={unavailable}
          onReconnectRemoteWorkspace={unavailable}
          reconnectingRemoteWorkspaceKeys={[]}
          remoteWorkspaceErrorByWorkspaceKey={{}}
          allowOpenWorkspace={false}
          allowRemoteWorkspace={false}
          supportsEmbeddedBrowser={false}
          user={props.applicationAccount?.profile}
          onLogout={props.applicationAccount?.onLogout}
        />
      </div>
      {settingsOpen && (
        <WorkspaceSettingsLayer
          onBack={closeSettings}
          onCreateTask={prepare}
          allowOpenWorkspace={false}
          user={props.applicationAccount?.profile}
          onLogout={props.applicationAccount?.onLogout}
        />
      )}
    </RootShell>
  );
}
