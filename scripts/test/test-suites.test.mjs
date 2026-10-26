import assert from "node:assert/strict";
import { glob } from "node:fs/promises";
import { relative } from "node:path";
import test from "node:test";
import { createVitest } from "vitest/node";
import {
  ROOT_TEST_INCLUDES,
  ROOT_TEST_EXCLUDES,
  integrationTests,
  isolatedIntegrationTests,
  UNIT_TEST_PROJECTS,
  INTEGRATION_TEST_PROJECTS,
} from "../test-suites.mjs";

test("unit 和 integration 收集互斥，合并后完整覆盖原根测试范围", async () => {
  const ctx = await createVitest("test", { watch: false, run: true }, { server: { watch: null } });
  try {
    const specs = await ctx.globTestSpecifications();
    const rows = specs.map((spec) => ({
      project: spec.project.name,
      path: relative(process.cwd(), spec.moduleId).replaceAll("\\", "/"),
    }));
    const units = new Set(
      rows.filter((r) => UNIT_TEST_PROJECTS.includes(r.project)).map((r) => r.path),
    );
    const integrations = new Set(
      rows.filter((r) => INTEGRATION_TEST_PROJECTS.includes(r.project)).map((r) => r.path),
    );
    assert.equal(units.size + integrations.size, rows.length, "每个测试文件只能归属一个套件");
    assert.deepEqual(
      [...units].filter((file) => integrations.has(file)),
      [],
    );
    const expected = [];
    for await (const file of glob(ROOT_TEST_INCLUDES, { exclude: ROOT_TEST_EXCLUDES }))
      expected.push(file.replaceAll("\\", "/"));
    assert.deepEqual(
      rows
        .filter((r) => r.project !== "cua-placeholder")
        .map((r) => r.path)
        .sort(),
      [...new Set(expected)].sort(),
      "分层不能遗漏原来收集的文件",
    );
    assert.equal(new Set(integrationTests).size, integrationTests.length);
    for (const file of integrationTests) assert(integrations.has(file), `失效的集成登记：${file}`);
    for (const file of isolatedIntegrationTests) assert(integrationTests.includes(file));
    for (const file of [
      "packages/ui/test/webRemoteControlDialogLayout.test.ts",
      "packages/rpc/test/channels.test.ts",
      "packages/services/test/processTreeTerminator.windows.test.ts",
    ])
      assert(units.has(file), `使用替身的隔离测试应留在 unit：${file}`);
    for (const file of [
      "packages/desktop/test/windowsInstallerCompile.test.ts",
      "packages/desktop/test/webRemoteControlTransport.test.ts",
      "packages/zcode-server-cli/test/runtimeUpdateIntegration.test.ts",
      "packages/services/src/project-storage/repository/contract.test.ts",
    ])
      assert(integrations.has(file), `真实 IO 不得进入 push 单测：${file}`);
  } finally {
    await ctx.close();
  }
});
