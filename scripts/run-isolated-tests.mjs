import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 旧夹具可能显式传 env:{}，只改 storage.dir 不能隔离 homedir() 下的默认库。
// 在整棵测试进程树建立真实 HOME 边界；工具链仍沿调用者已固定的 Node/PATH。
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [suite, ...args] = process.argv.slice(2);
if (suite !== "cli" && suite !== "unit") throw new Error("test_scope_required");
if (args[0] === "--") args.shift();
const sandbox = await mkdtemp(join(tmpdir(), "zcode-cli-tests-"));
await chmod(sandbox, 0o700);
const home = join(sandbox, "home");
const paths = {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
};
for (const path of Object.values(paths)) await mkdir(path, { recursive: true, mode: 0o700 });
const correlationId = randomUUID();
const report = (outcome, extra = {}) =>
  process.stdout.write(
    JSON.stringify({
      event: "engineering.native.tests",
      event_schema_version: 1,
      test_scope: suite,
      correlation_id: correlationId,
      outcome,
      home_isolated: true,
      sandbox_ref: basename(sandbox),
      ...extra,
    }) + "\n",
  );
let child;
const signals = ["SIGINT", "SIGTERM"];
const handlers = signals.map((signal) => () => child?.kill(signal));
try {
  report("started");
  const command =
    suite === "cli"
      ? [join(root, "node_modules/turbo/bin/turbo"), "run", "test", ...args]
      : [
          join(root, "node_modules/vitest/vitest.mjs"),
          "run",
          "--exclude",
          "packages/desktop/test/e2e/**/*.test.ts",
          ...args,
        ];
  child = spawn(process.execPath, command, {
    cwd: suite === "cli" ? join(root, "apps/zcode-cli") : root,
    env: { ...process.env, ...paths },
    stdio: "inherit",
  });
  signals.forEach((signal, index) => process.on(signal, handlers[index]));
  const { code, signal } = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveExit({ code: exitCode ?? 1, signal }));
  });
  process.exitCode = code;
  report(code === 0 ? "passed" : "failed", { exit_code: code, termination_signal: signal });
} catch (error) {
  process.exitCode = 1;
  report("failed", { reason_code: "runner_failed" });
  throw error;
} finally {
  signals.forEach((signal, index) => process.off(signal, handlers[index]));
  await rm(sandbox, { recursive: true, force: true });
  report("cleaned");
}
