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
});
