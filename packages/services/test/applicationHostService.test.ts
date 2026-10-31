import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createApplicationHostService } from "../src/application-host/applicationHostService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import type { IZCodeAgentService } from "../src/zcode-agent/zcodeAgent.js";

const native = {} as IZCodeAgentService;
const credentials = {} as ICredentialService;
describe("Application Host lifecycle", () => {
  it("records method outcomes without input, result or exception contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-app-diagnostics-"));
    const modulePath = join(root, "extension.mjs");
    const secret = "synthetic-private-token-and-prompt";
    await writeFile(
      modulePath,
      `export async function createApplicationHost(){return {
      async call(method,input){if(method==='fail')throw new Error(input.secret);return input;},
      async control(method,input){if(method==='fail')throw new Error(input.secret);return input;},
      async dispose(){} };}`,
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    let control!: import("../src/application-host/contract.js").ApplicationHostControlPort;
    const service = createApplicationHostService({
      native,
      credentials,
      storageRoot: root,
      modulePath,
      logger,
      onControlReady: (port) => {
        control = port;
      },
    });
    try {
      expect(
        await service.call("inspect", { secret, commandId: secret, sessionId: secret }),
      ).toEqual({ secret, commandId: secret, sessionId: secret });
      await expect(service.call("fail", { secret })).rejects.toThrow(
        "application_host_request_failed",
      );
      await expect(control.control("fail", { secret })).rejects.toThrow(
        "application_control_request_failed",
      );
      await expect(service.call("invalid\n" + secret, { secret })).rejects.toThrow(
        "application_host_invalid_request",
      );
      const completed = logger.info.mock.calls.find(
        (call) => call[2]?.event === "application.host.call" && call[2]?.outcome === "completed",
      )?.[2];
      expect(completed).toMatchObject({
        method: "inspect",
        outcome: "completed",
        durationMs: expect.any(Number),
        correlationId: expect.any(String),
      });
      expect(completed.durationMs).toBeGreaterThanOrEqual(0);
      expect(logger.warn.mock.calls.map((call) => call[2])).toEqual([
        expect.objectContaining({
          event: "application.host.call",
          method: "fail",
          outcome: "failed",
          reasonCode: "extension_failed",
        }),
        expect.objectContaining({
          event: "application.host.control",
          method: "fail",
          outcome: "failed",
        }),
        expect.objectContaining({
          event: "application.host.call",
          method: "invalid",
          reasonCode: "invalid_request",
        }),
      ]);
      expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(
        secret,
      );
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("records only started while a call waits, then correlates completion to the original command", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-app-pending-"));
    const modulePath = join(root, "extension.mjs");
    await writeFile(
      modulePath,
      `export async function createApplicationHost(){let finish;return {
      call(){return new Promise(resolve=>{finish=resolve;});},async dispose(){finish?.('released');}};}`,
    );
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const service = createApplicationHostService({
      native,
      credentials,
      storageRoot: root,
      modulePath,
      logger,
    });
    const commandId = "11d91ca2-1d75-447f-a978-b7dd336db381";
    const sessionId = "3284d0c9-c86c-4cca-85ba-4eb6308acaa1";
    const secret = "synthetic-private-input-and-authorization";
    const pending = service.call("conversationBindInput", {
      commandId,
      sessionId,
      secret,
      nested: { commandId: secret },
      authorization: secret,
    });
    try {
      await vi.waitFor(() =>
        expect(logger.info.mock.calls.some((call) => call[2]?.outcome === "initialized")).toBe(
          true,
        ),
      );
      const calls = () =>
        logger.info.mock.calls
          .map((call) => call[2])
          .filter((row) => row?.event === "application.host.call");
      expect(calls()).toEqual([
        expect.objectContaining({ outcome: "started", commandId, sessionId, durationMs: 0 }),
      ]);
      expect(logger.warn).not.toHaveBeenCalled();
      const correlationId = calls()[0].correlationId;
      await service.dispose();
      await expect(pending).resolves.toBe("released");
      expect(calls()).toEqual([
        expect.objectContaining({ outcome: "started", correlationId, commandId, sessionId }),
        expect.objectContaining({
          outcome: "completed",
          correlationId,
          commandId,
          sessionId,
          durationMs: expect.any(Number),
        }),
      ]);
      expect(JSON.stringify(logger.info.mock.calls)).not.toContain(secret);
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("starts the configured module without a renderer and disposes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-app-host-"));
    const marker = join(root, "started");
    const modulePath = join(root, "extension.mjs");
    await writeFile(
      modulePath,
      `import {writeFile} from 'node:fs/promises';
      export async function createApplicationHost({storageRoot}) {
        await writeFile(${JSON.stringify(marker)}, storageRoot);
        return {async call(method) {if(method==='fail') throw new Error('private secret'); return {state:method};}, async dispose(){await writeFile(${JSON.stringify(marker)}, 'disposed');}};
      }`,
    );
    const service = createApplicationHostService({
      native,
      credentials,
      storageRoot: root,
      modulePath,
    });
    try {
      await vi.waitFor(async () =>
        expect(await readFile(marker, "utf8")).toBe(join(root, "application")),
      );
      expect(await service.call("status", {})).toEqual({ state: "status" });
      await expect(service.call("fail", {})).rejects.toThrow(/^application_host_request_failed$/);
      await expect(service.call("../load", {})).rejects.toThrow("application_host_invalid_request");
      await service.dispose();
      expect(await readFile(marker, "utf8")).toBe("disposed");
      await expect(service.call("status", {})).rejects.toThrow("application_host_request_failed");
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("leaves an unconfigured native Host explicitly unavailable", async () => {
    const service = createApplicationHostService({ native, credentials, storageRoot: tmpdir() });
    await expect(service.call("status", {})).rejects.toThrow("application_host_request_failed");
    await service.dispose();
  });
  it("keeps trusted control separate from public call and rejects malformed admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-app-control-"));
    const modulePath = join(root, "extension.mjs");
    await writeFile(
      modulePath,
      `export async function createApplicationHost() {return {
      async call(){throw new Error('public method unavailable');},
      async control(method){return {state:method};},
      async beforeAutomationInput(input){
        if(input.automationId==='context') return {state:'admitted',context:{filename:'business.json',text:'{"fixed":true}'}};
        if(input.automationId==='large') return {state:'admitted',context:{filename:'business.json',text:'x'.repeat(16385)}};
        return input.automationId==='blocked'?'blocked':'invalid';},
      async dispose(){} };}`,
    );
    let privatePort!: import("../src/application-host/contract.js").ApplicationHostControlPort;
    const service = createApplicationHostService({
      native,
      credentials,
      storageRoot: root,
      modulePath,
      onControlReady: (port) => {
        privatePort = port;
      },
    });
    expect("control" in service).toBe(false);
    expect("beforeAutomationInput" in service).toBe(false);
    try {
      expect(await privatePort.control("inspect", {})).toEqual({ state: "inspect" });
      await expect(service.call("inspect", {})).rejects.toThrow("application_host_request_failed");
      const input = {
        automationId: "blocked",
        inputId: "synthetic-run",
        workspacePath: root,
        prompt: "synthetic",
      };
      expect(await privatePort.beforeAutomationInput(input)).toBe("blocked");
      expect(
        await privatePort.beforeAutomationInput({ ...input, automationId: "context" }),
      ).toEqual({
        state: "admitted",
        context: { filename: "business.json", text: '{"fixed":true}' },
      });
      expect(await privatePort.beforeAutomationInput({ ...input, automationId: "large" })).toBe(
        "unavailable",
      );
      expect(await privatePort.beforeAutomationInput({ ...input, automationId: "invalid" })).toBe(
        "unavailable",
      );
    } finally {
      await service.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("projects bounded extension observations without arbitrary text or fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-app-observation-"));
  const modulePath = join(root, "extension.mjs");
  await writeFile(modulePath, `export async function createApplicationHost({logger}) {
    logger.info('synthetic.source', {outcome:'unavailable',phase:'discovery',reason_code:'source_unavailable',source_ref:'opaque-source',secret:'private content'});
    logger.warn('private content', {outcome:'failed',secret:'private content'});
    return {async call(){},async dispose(){}}; }`);
  const logger = {info:vi.fn(),warn:vi.fn(),error:vi.fn(),debug:vi.fn()};
  const service = createApplicationHostService({native,credentials,storageRoot:root,modulePath,logger});
  try {
    await service.call('inspect',{});
    expect(logger.info.mock.calls.map(call=>call[2])).toContainEqual(expect.objectContaining({
      event:'application.host.extension',method:'synthetic.source',outcome:'unavailable',
      phase:'discovery',reasonCode:'source_unavailable',correlationId:'opaque-source',
    }));
    expect(logger.warn.mock.calls[0][2]).toMatchObject({event:'application.host.extension',method:'extension',outcome:'failed'});
    expect(JSON.stringify([logger.info.mock.calls,logger.warn.mock.calls])).not.toContain('private content');
  } finally { await service.dispose(); await rm(root,{recursive:true,force:true}); }
});
