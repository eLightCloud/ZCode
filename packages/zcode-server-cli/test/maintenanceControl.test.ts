import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runServerCli } from "../src/cli.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { resolveServerLayout } from "../src/runtime/paths.js";

it("routes exact maintenance input and validates its owner receipt over private control", async () => {
  const root = await mkdtemp(join(tmpdir(), "zmc-"));
  const layout = resolveServerLayout(root);
  await mkdir(layout.runDir, { recursive: true });
  const operationId = randomUUID();
  const requests: unknown[] = [];
  const control = await createControlServer(layout.controlEndpoint, async (request) => {
    requests.push(request);
    return { state: "held", operationId };
  });
  const output: string[] = [];
  try {
    expect(
      await runServerCli(
        ["maintenance", "begin", "--operation-id", operationId, "--server-root", root, "--json"],
        { stdout: { write: (value) => output.push(value) } },
      ),
    ).toBe(0);
    expect(requests).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        command: "maintenance",
        input: { action: "begin", operationId },
      },
    ]);
    expect(JSON.parse(output.join(""))).toEqual({ state: "held", operationId });
  } finally {
    await control.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a false held receipt instead of accepting a successful transport response", async () => {
  const root = await mkdtemp(join(tmpdir(), "zmc-"));
  const layout = resolveServerLayout(root);
  await mkdir(layout.runDir, { recursive: true });
  const control = await createControlServer(layout.controlEndpoint, async () => ({
    state: "held",
    operationId: null,
  }));
  const output: string[] = [];
  try {
    expect(
      await runServerCli(
        ["maintenance", "begin", "--operation-id", randomUUID(), "--server-root", root, "--json"],
        { stdout: { write: (value) => output.push(value) } },
      ),
    ).toBe(1);
    expect(JSON.parse(output.join(""))).toMatchObject({ ok: false });
  } finally {
    await control.close();
    await rm(root, { recursive: true, force: true });
  }
});
