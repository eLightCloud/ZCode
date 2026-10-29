import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
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
    const enabled = await service.get(paused.automationId, {
      workspacePath: directory,
    });
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
    await expect(
      service.create({ ...params, prompt: "different input" }),
    ).rejects.toThrow("conflicts");
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

it("inspects an original creation without creating, enabling or accepting changed parameters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-creation-inspect-"));
  let repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
  try {
    let service = new AutomationService(repo);
    const params = {
      creationId: randomUUID(),
      enabled: false,
      title: "synthetic recovery",
      cronExpr: "*/10 * * * *",
      prompt: "synthetic fixed input",
      workspacePath: directory,
      recurring: true,
    };
    const create = vi.spyOn(repo, "create");
    expect(await service.inspectCreation(params)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    const first = await service.create(params);
    create.mockClear();
    expect(await service.inspectCreation(params)).toEqual(first);
    expect(await service.inspectCreation(params)).toEqual(first);
    await expect(
      service.inspectCreation({ ...params, prompt: "changed" }),
    ).rejects.toThrow("conflicts");
    expect(create).not.toHaveBeenCalled();
    expect(await service.list()).toEqual([first]);
    expect(first.enabled).toBe(false);
    expect(await service.listRuns(first.automationId)).toEqual([]);
    repo.close();
    repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
    service = new AutomationService(repo);
    const createAfterRestart = vi.spyOn(repo, "create");
    expect(await service.inspectCreation(params)).toEqual(first);
    expect(createAfterRestart).not.toHaveBeenCalled();
  } finally {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("pins the application default once and never rebinds an idempotent creation to the next account", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-application-owner-"));
  const repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
  const original = {
    providerId: "application:original-person",
    modelId: "model",
    options: { reasoningLevel: "disabled" },
  };
  const current = vi.fn().mockResolvedValue(original);
  try {
    const service = new AutomationService(repo, undefined, current);
    const input = {
      creationId: randomUUID(),
      enabled: false,
      title: "bound",
      cronExpr: "0 9 * * *",
      prompt: "fixed",
      workspacePath: directory,
      recurring: true,
    };
    const saved = await service.create(input);
    expect(saved.modelSelection).toEqual(original);
    current.mockResolvedValue({
      ...original,
      providerId: "application:different-person",
    });
    expect((await service.create(input)).modelSelection).toEqual(original);
    expect((await service.inspectCreation(input))?.automationId).toBe(
      saved.automationId,
    );
    expect(current).toHaveBeenCalledOnce();
    await expect(
      service.create({
        ...input,
        modelSelection: {
          ...original,
          providerId: "application:different-person",
        },
      }),
    ).rejects.toThrow("conflicts");
  } finally {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects editing an application rule into another account or a personal provider", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-account-edit-"));
  const repo = new AutomationRepo(join(directory, "tasks-index.sqlite"));
  const original = {
    providerId: "application:original-person",
    modelId: "first",
    options: { reasoningLevel: "disabled" },
  };
  try {
    const service = new AutomationService(repo);
    const saved = await service.create({
      title: "owned",
      cronExpr: "0 9 * * *",
      prompt: "original",
      workspacePath: directory,
      recurring: true,
      enabled: false,
      modelSelection: original,
    });
    const scope = { workspacePath: directory };
    const update = vi.spyOn(repo, "update");
    for (const modelSelection of [
      null,
      { ...original, providerId: "application:other-person" },
      { ...original, providerId: "personal:local" },
    ]) {
      await expect(
        service.update(
          saved.automationId,
          { prompt: "hijacked", modelSelection },
          scope,
        ),
      ).rejects.toThrow("AUTOMATION_APPLICATION_ACCOUNT_FIXED");
    }
    expect(update).not.toHaveBeenCalled();
    expect((await service.get(saved.automationId, scope))?.prompt).toBe(
      "original",
    );
    const changed = await service.update(
      saved.automationId,
      { modelSelection: { ...original, modelId: "second" } },
      scope,
    );
    expect(changed?.modelSelection?.modelId).toBe("second");
    const personal = await service.create({
      title: "personal",
      cronExpr: "0 9 * * *",
      prompt: "personal",
      workspacePath: directory,
      recurring: true,
      enabled: false,
      modelSelection: { ...original, providerId: "personal:first" },
    });
    expect(
      (
        await service.update(
          personal.automationId,
          { modelSelection: { ...original, providerId: "personal:second" } },
          scope,
        )
      )?.modelSelection?.providerId,
    ).toBe("personal:second");
  } finally {
    repo.close();
    await rm(directory, { recursive: true, force: true });
  }
});
