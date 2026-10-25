import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { AutomationService } from "../src/session/automationService.js";

it("creates a paused definition without a claimable time and lets the native owner enable it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-paused-create-"));
  const repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
  try {
    const service = new AutomationService(repo);
    const paused = await service.create({
      title: "synthetic paused",
      cronExpr: "0 9 * * *",
      prompt: "synthetic fixed input",
      workspacePath: directory,
      recurring: true,
      enabled: false,
    });
    expect(paused.enabled).toBe(false);
    expect(paused.lifecycleStatus).toBe("paused");
    expect(paused.nextRunAt).toBeUndefined();
    expect(await repo.claimDue(Date.now() + 86400_000)).toEqual([]);
    await service.setEnabled(paused.automationId, true, {
      workspacePath: directory,
    });
    const enabled = await service.get(paused.automationId, { workspacePath: directory });
    expect(enabled?.enabled).toBe(true);
    expect(enabled?.nextRunAt).toBeGreaterThan(Date.now());
    const ordinary = await service.create({
      title: "synthetic ordinary",
      cronExpr: "0 10 * * *",
      prompt: "synthetic fixed input",
      workspacePath: directory,
      recurring: true,
    });
    expect(ordinary.enabled).toBe(true);
  } finally {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps paused creation and a completed manual request stable across retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-automation-request-"));
  const repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
  try {
    const service = new AutomationService(repo);
    const params = {
      creationId: randomUUID(),
      enabled: false,
      title: "synthetic stable",
      cronExpr: "0 9 * * *",
      prompt: "synthetic fixed input",
      workspacePath: directory,
      recurring: true,
    };
    const first = await service.create(params);
    const duplicate = await service.create(params);
    expect(duplicate.automationId).toBe(first.automationId);
    expect(await service.list()).toHaveLength(1);
    await expect(service.create({ ...params, prompt: "different input" })).rejects.toThrow(
      "conflicts",
    );
    const requestId = randomUUID();
    const claimed = await service.runNow(
      first.automationId,
      { workspacePath: directory },
      requestId,
    );
    expect(claimed?.replayed).toBeUndefined();
    await repo.markRunOutcome(claimed!.run.runId, "succeeded");
    await repo.releaseManualClaim(first.automationId, first.workspaceKey);
    const replay = await service.runNow(
      first.automationId,
      { workspacePath: directory },
      requestId,
    );
    expect(replay?.replayed).toBe(true);
    expect(replay?.run.runId).toBe(claimed?.run.runId);
    expect(await service.listRuns(first.automationId)).toHaveLength(1);
  } finally {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
