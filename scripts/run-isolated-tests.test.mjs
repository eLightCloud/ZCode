import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

for (const [suite, override] of [
  ["unit", ["--project", "integration"]],
  ["integration", ["--project=unit"]],
]) {
  test(`${suite}: rejects a caller override of the owned test projects`, () => {
    const entry = fileURLToPath(new URL("./run-isolated-tests.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [entry, suite, ...override], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /test_scope_project_override/);
    assert(!result.stdout.includes("engineering.native.tests"), "不能先启动错误的测试项目再报错");
  });
}

for (const suite of ["cli", "unit", "integration", "all"])
  for (const [expectedCode, signal] of [
    [0, null],
    [7, null],
    [1, "SIGTERM"],
  ]) {
    test(`${suite}: isolates and cleans after exit ${expectedCode}, signal ${signal}`, async () => {
      const fixture = await mkdtemp(join(tmpdir(), "cli-test-home-contract-"));
      try {
        for (const path of [
          "scripts",
          "apps/zcode-cli",
          "node_modules/turbo/bin",
          "node_modules/vitest",
          "outside-home",
        ])
          await mkdir(join(fixture, path), { recursive: true });
        const outside = join(fixture, "outside-home");
        await writeFile(join(fixture, "package.json"), JSON.stringify({ type: "module" }));
        await writeFile(join(outside, "existing-data"), "synthetic existing bytes");
        const entry = join(fixture, "scripts/run-isolated-tests.mjs");
        await copyFile(
          join(dirname(fileURLToPath(import.meta.url)), "run-isolated-tests.mjs"),
          entry,
        );
        await copyFile(
          join(dirname(fileURLToPath(import.meta.url)), "test-suites.mjs"),
          join(fixture, "scripts/test-suites.mjs"),
        );
        await writeFile(
          join(
            fixture,
            suite === "cli" ? "node_modules/turbo/bin/turbo" : "node_modules/vitest/vitest.mjs",
          ),
          `
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const home = os.homedir();
fs.writeFileSync(path.join(home, 'synthetic-test-db'), 'synthetic fixture');
console.log(JSON.stringify({probe:true, home, config:process.env.XDG_CONFIG_HOME, args:process.argv.slice(2)}));
${signal ? `process.kill(process.pid, '${signal}');` : `process.exit(${expectedCode});`}
`,
        );
        const result = spawnSync(process.execPath, [entry, suite, "--", "--concurrency=1"], {
          env: { ...process.env, HOME: outside, USERPROFILE: outside },
          encoding: "utf8",
        });
        assert.equal(result.status, expectedCode, result.stderr);
        const rows = result.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const probe = rows.find((row) => row.probe);
        assert(probe);
        assert.notEqual(probe.home, outside);
        assert(probe.config.startsWith(probe.home));
        assert.deepEqual(
          probe.args,
          suite === "cli"
            ? ["run", "test", "--concurrency=1"]
            : [
                "run",
                "--exclude",
                "packages/desktop/test/e2e/**/*.test.ts",
                ...(suite === "unit"
                  ? ["--project", "unit", "--project", "cua-placeholder"]
                  : suite === "integration"
                    ? ["--project", "integration", "--project", "integration-isolated"]
                    : []),
                "--concurrency=1",
              ],
        );
        assert.equal(
          await readFile(join(outside, "existing-data"), "utf8"),
          "synthetic existing bytes",
        );
        await assert.rejects(stat(probe.home), { code: "ENOENT" });
        assert.equal(rows.at(-1).outcome, "cleaned");
        const finished = rows.find((row) => row.outcome === "passed" || row.outcome === "failed");
        assert.equal(finished.test_scope, suite);
        assert.deepEqual(
          finished.test_projects,
          suite === "unit"
            ? ["unit", "cua-placeholder"]
            : suite === "integration"
              ? ["integration", "integration-isolated"]
              : [],
        );
        assert.equal(finished.exit_code, expectedCode);
        assert.equal(finished.termination_signal, signal);
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    });
  }
