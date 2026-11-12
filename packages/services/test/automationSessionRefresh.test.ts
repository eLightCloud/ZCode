import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeSessionStateSnapshot, ZCodeTaskMeta } from "@zcode/shared";
import { ServiceCollection } from "../src/collection.js";
import { IModelSelectionService } from "../src/model-provider/providerFacadeServices.js";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { createAutomationDispatcher } from "../src/session/automationDispatcher.js";
import { IZCodeTaskService } from "../src/session/zcodeTaskService.js";
import type { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import type { IZCodeAgentService, ZCodeAgentServiceEvent } from "../src/zcode-agent/zcodeAgent.js";
import type { ZCodeTaskIndexSyncer } from "../src/zcode-agent/zcodeTaskIndexSyncer.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  warm: boolean,
  clientMode: "desktop-continuous" | "web-remote-replayable",
  refresh = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "automation-refresh-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
  cleanups.push(() => repo.close());
  const selection = { providerId: "test", modelId: "test", options: { reasoningLevel: "high" } };
  const taskId = "session_automation_refresh";
  const snapshot: ZCodeSessionStateSnapshot = {
    protocol: { name: "ZCode Protocol", version: 1 },
    session: {
      sessionId: taskId,
      workspace: { workspacePath: directory, workspaceKey: directory },
      sessionKind: "interactive",
      title: "Existing task",
      mode: "build",
      status: "idle",
      model: selection,
      createdAt: 10,
      updatedAt: 20,
    },
    settings: {
      model: {
        current: selection,
        available: [{ ref: selection, label: "Test", contextWindow: 128000 }],
        lastUsed: selection,
      },
      thoughtLevel: {
        enabled: true,
        current: "high",
        available: [{ value: "high", label: "High" }],
      },
      mode: { current: "build" },
    },
    projection: {
      sessionId: taskId,
      status: "idle",
      mode: "build",
      turnCount: 0,
      totalTokenCount: 0,
      contextUsed: 0,
      contextWindow: 128000,
      pendingPermissions: [],
      activeToolCalls: [],
      backgroundJobs: [],
    },
    runtime: { eventSeq: 0, stateRevision: 1, pendingRequestIds: [] },
    messages: [],
  };
  let meta: ZCodeTaskMeta = {
    taskId,
    workspacePath: directory,
    title: "Existing task",
    provider: "glm",
    status: "idle",
    createdAt: 10,
    updatedAt: 20,
    model: "test/test",
    thoughtLevel: "high",
  };
  let resident = warm;
  let mcpPending = false;
  let genuinelyBusy = false;
  const events = new Emitter<ZCodeAgentServiceEvent>();
  // RPC port reproduces the resident owner's busy contract without contacting a model/MCP.
  const resume = vi.fn<IZCodeAgentService["resumeSession"]>(async (params) => {
    if (params.refreshConfiguration && resident && (mcpPending || genuinelyBusy)) {
      throw new Error("Session configuration refresh busy");
    }
    if (!resident || params.refreshConfiguration) {
      resident = true;
      mcpPending = true;
    }
    return snapshot;
  });
  const send = vi.fn<IZCodeAgentService["sendPrompt"]>(async () => snapshot);
  const command = vi.fn<IZCodeAgentService["sendConversationCommandV4"]>(async (params) => ({
    commandId: params.envelope.commandId,
    status: "accepted",
    revisionAtDecision: 1,
  }));
  const agent = {
    resumeSession: resume,
    sendPrompt: send,
    sendConversationCommandV4: command,
    onDynamicSessionEvent: () => events.event,
    disposeAll: vi.fn(),
  } as unknown as IZCodeAgentService;
  const index = {
    close: vi.fn(),
    getTaskMeta: async () => meta,
    updateTaskPresentation: async (params: { presentation: Partial<ZCodeTaskMeta> }) => {
      meta = { ...meta, ...params.presentation };
      return meta;
    },
  } as unknown as TaskIndexRepo;
  const syncer = {
    getWorkspaceEmitter: () => new Emitter(),
    ensureSessionSubscription: vi.fn(),
    syncSnapshotAndBroadcast: async () => meta,
    onWorkspaceTaskListChanged: () => new Emitter().event,
    onSessionTerminalEvent: () => ({ dispose: vi.fn() }),
    onSessionReadyEvent: () => ({ dispose: vi.fn() }),
    disposeAll: vi.fn(),
  } as unknown as ZCodeTaskIndexSyncer;
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: agent,
    taskIndexRepo: index,
    taskIndexSyncer: syncer,
  });
  cleanups.push(() => service.disposeAll());
  const services = new ServiceCollection()
    .register(IZCodeTaskService, service)
    .register(IModelSelectionService, {
      getView: async () => ({ effectiveSelection: selection, preferredSelection: selection }),
    } as unknown as IModelSelectionService);
  const automation = await repo.create(
    {
      title: "Synthetic refresh regression",
      cronExpr: "0 9 * * *",
      prompt: "Reply CHECK_OK only",
      recurring: true,
      workspacePath: directory,
      modelSelection: selection,
    },
    { nextRunAt: Date.now() + 3600000 },
  );
  const dispatcher = createAutomationDispatcher({
    repo,
    resolveServices: () => services,
    clientMode,
    logWarn: vi.fn(),
    beforeAutomationInput: async () => (refresh ? { refreshConfiguration: true } : undefined),
  });
  cleanups.push(() => dispatcher.dispose());
  async function dispatch(manual = false) {
    const now = Date.now();
    const runId = `${automation.automationId}:${manual ? "manual:" : ""}${now}`;
    await repo.upsertRunClaimed({
      runId,
      automationId: automation.automationId,
      workspaceKey: directory,
      scheduledAt: manual ? null : now,
      trigger: manual ? "manual" : "schedule",
    });
    return dispatcher.dispatch({
      automationId: automation.automationId,
      runId,
      workspacePath: directory,
      prompt: "Reply CHECK_OK only",
      modelSelection: selection,
      mode: "yolo",
      targetTaskId: taskId,
    });
  }
  return {
    resume,
    send,
    command,
    dispatch,
    service,
    taskId,
    directory,
    finishMcp: () => {
      mcpPending = false;
    },
    busy: () => {
      genuinelyBusy = true;
    },
  };
}

describe("automation session refresh request lifetime", () => {
  it.each(["desktop-continuous", "web-remote-replayable"] as const)(
    "does not refresh ordinary automation on %s, even when resident refresh is busy",
    async (mode) => {
      const f = await fixture(true, mode, false);
      f.busy();
      await f.dispatch();
      await f.dispatch(true);
      expect(f.resume.mock.calls.every(([p]) => p.refreshConfiguration === undefined)).toBe(true);
      expect(f.command.mock.calls.filter(([p]) => p.envelope.type === "sendText")).toHaveLength(2);
    },
  );
  it.each([
    [false, "desktop-continuous"],
    [true, "desktop-continuous"],
    [false, "web-remote-replayable"],
    [true, "web-remote-replayable"],
  ] as const)(
    "dispatches warm=%s on %s while MCP startup is still pending",
    async (warm, clientMode) => {
      const f = await fixture(warm, clientMode);
      await expect(f.dispatch()).resolves.toEqual({ taskId: f.taskId, sessionId: f.taskId });
      expect(f.resume.mock.calls.map(([p]) => p.refreshConfiguration)).toEqual([true, undefined]);
      expect(f.command.mock.calls.map(([p]) => p.envelope.type)).toEqual([
        "switchModelConfig",
        "switchModelConfig",
        "switchCollaborationMode",
        "sendText",
      ]);
      f.finishMcp();
      await f.dispatch(true);
      expect(f.resume.mock.calls.map(([p]) => p.refreshConfiguration)).toEqual([
        true,
        undefined,
        true,
        undefined,
      ]);
    },
  );

  it("keeps real busy refusal before model configuration and input", async () => {
    const f = await fixture(true, "web-remote-replayable");
    f.busy();
    await expect(f.dispatch()).rejects.toThrow();
    expect(f.command).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});
