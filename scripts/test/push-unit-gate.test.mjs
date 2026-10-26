import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const scripts = JSON.parse(await readFile(join(repository, "package.json"), "utf8")).scripts;

// 检验真实 hook 和 package 编排；夹具中的替身只证明接线，全量结果由正式入口另行验证。
for (const [selection, unitCode, staticCode, staticStep = "lint"] of [
  ["none", 0, 0],
  ["all", 0, 0],
  ["none", 7, 0],
  ["all", 7, 0],
  ["all", 0, 3],
  ["all", 0, 3, "suites"],
]) {
  test(`push ${selection}: full unit exit ${unitCode}, static ${staticStep} exit ${staticCode}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "push-unit-contract-"));
    try {
      const remote = join(directory, "remote.git");
      const checkout = join(directory, "checkout");
      const log = join(directory, "steps.jsonl");
      await mkdir(checkout);
      const env = {
        ...process.env,
        CONTRACT_LOG: log,
        UNIT_CODE: String(unitCode),
        STATIC_CODE: String(staticCode),
        STATIC_STEP: staticStep,
        AFFECTED_SELECTION: selection,
      };
      for (const key of Object.keys(env))
        if (key.startsWith("GIT_") || key.startsWith("ZCODE_PRE_PUSH_")) delete env[key];
      const run = (command, args, cwd = checkout) =>
        spawnSync(command, args, {
          cwd,
          env,
          encoding: "utf8",
          timeout: 30000,
        });
      const git = (...args) => {
        const result = run("git", [
          "-c",
          "user.name=Synthetic",
          "-c",
          "user.email=synthetic@example.test",
          "-c",
          "commit.gpgsign=false",
          ...args,
        ]);
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git("init", "--bare", remote);
      git("init", "--initial-branch=main");
      await mkdir(join(checkout, "scripts"));
      await mkdir(join(checkout, "node_modules/vitest"), { recursive: true });
      await copyFile(
        join(repository, "scripts/run-isolated-tests.mjs"),
        join(checkout, "scripts/run-isolated-tests.mjs"),
      );
      await copyFile(
        join(repository, "scripts/test-suites.mjs"),
        join(checkout, "scripts/test-suites.mjs"),
      );
      await writeFile(
        join(checkout, "leaf.mjs"),
        `
import fs from 'node:fs';
const step=process.argv[2];
fs.appendFileSync(process.env.CONTRACT_LOG, JSON.stringify({step,args:process.argv.slice(3)})+'\\n');
if(step==='affected') console.log('selection='+process.env.AFFECTED_SELECTION);
process.exit(step===process.env.STATIC_STEP ? Number(process.env.STATIC_CODE) : 0);
`,
      );
      await writeFile(
        join(checkout, "node_modules/vitest/vitest.mjs"),
        `
import fs from 'node:fs'; import os from 'node:os';
fs.appendFileSync(process.env.CONTRACT_LOG, JSON.stringify({step:'unit',home:os.homedir(),args:process.argv.slice(2)})+'\\n');
process.exit(Number(process.env.UNIT_CODE));
`,
      );
      await writeFile(
        join(checkout, "package.json"),
        JSON.stringify({
          type: "module",
          scripts: {
            "verify:pre-push": scripts["verify:pre-push"],
            lint: "node leaf.mjs lint",
            "db:schema:check": "node leaf.mjs schema",
            "test:architecture": "node leaf.mjs architecture",
            "architecture:check": "node leaf.mjs boundaries",
            "test:suites:check": "node leaf.mjs suites",
            "test:unit:affected": "node leaf.mjs affected",
            "test:unit": scripts["test:unit"],
          },
        }),
      );
      await writeFile(join(checkout, ".gitignore"), "node_modules\n");
      git("add", ".");
      git("commit", "-m", "Synthetic hook contract");
      git("remote", "add", "origin", remote);
      const hook = join(checkout, ".git/hooks/pre-push");
      await copyFile(join(repository, ".husky/pre-push"), hook);
      await chmod(hook, 0o755);
      const result = run("git", ["push", "origin", "main"]);
      const rows = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
      const units = rows.filter(({ step }) => step === "unit");
      if (staticCode) {
        assert.deepEqual(
          rows.map(({ step }) => step),
          ["lint", "boundaries", "suites"].slice(
            0,
            ["lint", "boundaries", "suites"].indexOf(staticStep) + 1,
          ),
        );
      } else {
        assert.equal(units.length, 1, result.stderr);
        assert.notEqual(units[0].home, process.env.HOME);
        assert.deepEqual(
          rows.map(({ step }) => step),
          ["lint", "boundaries", "suites", "affected", "unit"],
        );
        assert.deepEqual(units[0].args, [
          "run",
          "--exclude",
          "packages/desktop/test/e2e/**/*.test.ts",
          "--project",
          "unit",
          "--project",
          "cua-placeholder",
        ]);
        assert(!units[0].args.includes("integration"));
        const preview = rows.find(({ step }) => step === "affected");
        assert.deepEqual(preview.args, ["--scope", "push", "--dry-run"]);
      }
      const published = run("git", [
        "--git-dir",
        remote,
        "rev-parse",
        "--verify",
        "refs/heads/main",
      ]);
      if (unitCode || staticCode) {
        assert.notEqual(result.status, 0);
        assert.notEqual(published.status, 0, "failed checks must leave the remote ref absent");
      } else {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(published.stdout.trim(), git("rev-parse", "HEAD"));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
