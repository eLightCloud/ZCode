import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { WorkflowRunSettingsPopover } from "@/components/workflow-timeline/WorkflowRunSettingsPopover.js";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const name =
  params.get("name") === "short"
    ? "GLM"
    : params.get("name") === "extreme"
      ? `GLM-${"LongModelName".repeat(20)}`
      : "GLM-5.3-Highspeed";
function Fixture() {
  const [selected, setSelected] = useState("text");
  const [settingsOpened, setSettingsOpened] = useState(false);
  const catalog = params.get("catalog");
  const applicationGroups = buildRegistryModelSelectGroups(
    "glm",
    catalog === "loading"
      ? null
      : {
          revision: 1,
          providers:
            catalog === "system" || catalog === "personal"
              ? [
                  {
                    providerId: catalog === "system" ? "application:fixture" : "personal:fixture",
                    providerName: "Fixture",
                    config: {
                      group: catalog === "system" ? "application-managed" : "standard-personal",
                      api: { type: "openai-chat-completions" },
                    },
                    models: [{ modelId: "configured-model", config: {} }],
                  },
                ]
              : [],
        },
  );
  return (
    <ZCodeIntlProvider initialLocale={params.get("locale") === "zh-CN" ? "zh-CN" : "en-US"}>
      {params.has("workflow") ? (
        <WorkflowFixture />
      ) : (
        <div className="p-8">
          <ModelConfigSelect
            modelGroups={
              catalog
                ? applicationGroups
                : [
                    {
                      key: "custom",
                      label: "Custom provider",
                      items: [
                        { key: "text", value: "text", name },
                        { key: "vision", value: "vision", name, supportsVisionInput: true },
                      ],
                    },
                  ]
            }
            normalizedValue={selected}
            triggerLabel="Models"
            triggerAriaLabel="Models"
            showManageModelsAction={Boolean(catalog)}
            onManageModels={() => setSettingsOpened(true)}
            lockReasonMessage=""
            isItemLocked={() => false}
            onValueChange={setSelected}
            focusSelectorOnClose={null}
            providerSubmenuClassName={
              innerWidth < 600
                ? "w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)"
                : undefined
            }
          />
          <output data-testid="selected">{selected}</output>
          <output data-testid="settings-opened">{String(settingsOpened)}</output>
        </div>
      )}
    </ZCodeIntlProvider>
  );
}

function WorkflowFixture() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [applied, setApplied] = useState("");
  const run: WorkflowRunState = {
    runId: "synthetic",
    toolCallId: "synthetic",
    status: "running",
    usage: { spentTokens: 0, nodesUsed: 0 },
    actors: [],
    nodes: [],
    lastEventSequence: 0,
    concurrencyCeiling: 4,
  };
  return (
    <div className="p-8">
      <button ref={anchor} onClick={() => setOpen(true)}>
        Workflow settings
      </button>
      <WorkflowRunSettingsPopover
        anchorRef={anchor}
        open={open}
        onOpenChange={setOpen}
        run={run}
        host={{
          workspacePath: "/synthetic",
          sessionModel: { providerId: "synthetic", modelId: "session-model" },
          apply: async (change) => {
            setApplied(JSON.stringify(change));
            return {
              status: "accepted",
              commandId: "synthetic",
              revisionAtDecision: 1,
            };
          },
        }}
      />
      <output data-testid="workflow-applied">{applied}</output>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
