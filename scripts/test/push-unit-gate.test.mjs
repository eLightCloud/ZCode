import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const scripts = JSON.parse(await readFile(join(repository, "package.json"), "utf8")).scripts;

// 真实 Git / hook / package 编排；只有叶子检查使用替身，不能冒充本轮完整单测结果。
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "verified-push-contract-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const checkout = join(directory, "checkout");
  const remote = join(directory, "remote.git");
  await mkdir(checkout);
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith("GIT_") || key.startsWith("ZCODE_PRE_PUSH_") || key === "HUSKY")
      delete env[key];
  Object.assign(env, { UNIT_CODE: "0", STATIC_CODE: "0", STATIC_STEP: "lint" });
  const run = (command, args, extra = {}) =>
    spawnSync(command, args, {
      cwd: checkout,
      env,
      encoding: "utf8",
      timeout: 30000,
      ...extra,
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
  git("config", "core.hooksPath", ".hooks");
  git("remote", "add", "origin", remote);
  await mkdir(join(checkout, "scripts"));
  await mkdir(join(checkout, ".hooks"));
  await mkdir(join(checkout, "node_modules/vitest"), { recursive: true });
  for (const file of [
    "verified-push.mjs",
    "run-isolated-tests.mjs",
    "test-suites.mjs",
    "mise-run.mjs",
    "mise-toolchain-env.mjs",
  ])
    await copyFile(join(repository, "scripts", file), join(checkout, "scripts", file));
  await copyFile(join(repository, ".husky/pre-push"), join(checkout, ".hooks/pre-push"));
  await chmod(join(checkout, ".hooks/pre-push"), 0o755);
  await writeFile(
    join(checkout, "leaf.mjs"),
    `
import fs from 'node:fs';
const step=process.argv[2];
fs.appendFileSync('.git/steps.jsonl',JSON.stringify({step,args:process.argv.slice(3)})+'\\n');
process.exit(step===process.env.STATIC_STEP ? Number(process.env.STATIC_CODE) : 0);
`,
  );
  await writeFile(
    join(checkout, "tool.mjs"),
    `
import fs from 'node:fs'; console.log(fs.readFileSync('.git/tool-version','utf8'));
`,
  );
  await writeFile(join(checkout, ".git/tool-version"), "tool-1");
  await writeFile(join(checkout, ".git/installation"), "deps-1");
  await writeFile(
    join(checkout, "node_modules/vitest/vitest.mjs"),
    `
import fs from 'node:fs'; import os from 'node:os';
fs.appendFileSync('.git/steps.jsonl',JSON.stringify({step:'unit',home:os.homedir(),args:process.argv.slice(2)})+'\\n');
if(process.env.UNIT_SIGNAL) process.kill(process.pid, 'SIGTERM');
if(process.env.MUTATE_SOURCE) fs.appendFileSync('leaf.mjs','\\n// changed during verification');
if(process.env.MUTATE_TOOL) fs.writeFileSync('.git/tool-version','tool-new');
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
        "architecture:check": "node leaf.mjs boundaries",
        "test:suites:check": "node leaf.mjs suites",
        "test:unit": scripts["test:unit"],
      },
    }),
  );
  await writeFile(
    join(checkout, ".push-verification.json"),
    JSON.stringify({
      version: 1,
      entry: "pnpm push",
      hooksPath: ".hooks",
      hookFiles: [".hooks/pre-push"],
      verify: ["node", "scripts/mise-run.mjs", "pnpm", "run", "verify:pre-push"],
      tools: [[process.execPath, "tool.mjs"]],
      localInputs: [".git/installation"],
      environment: ["CONTRACT_ENV"],
    }),
  );
  await writeFile(join(checkout, ".gitignore"), "node_modules\n");
  git("add", ".");
  git("commit", "-m", "Synthetic verified push contract");
  const push = (...args) => run(process.execPath, ["scripts/verified-push.mjs", "push", ...args]);
  const rows = async () => {
    try {
      return (await readFile(join(checkout, ".git/steps.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const receipts = async () => {
    try {
      return (await readdir(join(checkout, ".git/verified-push"))).filter((file) =>
        file.endsWith(".json"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const published = () =>
    run("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/main"]);
  return { checkout, remote, directory, env, run, git, push, rows, receipts, published };
}

for (const [unitCode, staticCode, staticStep] of [
  [0, 0, "lint"],
  [7, 0, "lint"],
  [0, 3, "lint"],
  [0, 3, "suites"],
  [0, 3, "boundaries"],
]) {
  test(`verification unit=${unitCode}, ${staticStep}=${staticCode} gates real push`, async (t) => {
    const f = await fixture(t);
    Object.assign(f.env, {
      UNIT_CODE: String(unitCode),
      STATIC_CODE: String(staticCode),
      STATIC_STEP: staticStep,
    });
    const result = f.push("origin", "main");
    const rows = await f.rows();
    if (unitCode || staticCode) {
      assert.notEqual(result.status, 0);
      assert.notEqual(f.published().status, 0);
      assert.equal((await f.receipts()).length, 0);
      assert(
        !result.stdout.includes('"step":"transport"'),
        "validation must finish before any transport",
      );
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(f.published().stdout.trim(), f.git("rev-parse", "HEAD"));
      assert.equal((await f.receipts()).length, 1);
    }
    if (staticCode)
      assert.deepEqual(
        rows.map(({ step }) => step),
        ["lint", "boundaries", "suites"].slice(
          0,
          ["lint", "boundaries", "suites"].indexOf(staticStep) + 1,
        ),
      );
    else {
      assert.deepEqual(
        rows.map(({ step }) => step),
        ["lint", "boundaries", "suites", "unit"],
      );
      assert.deepEqual(rows[1].args, [], "full architecture is independent of a remote base");
      assert.notEqual(rows[3].home, process.env.HOME);
      assert.deepEqual(rows[3].args, [
        "run",
        "--exclude",
        "packages/desktop/test/e2e/**/*.test.ts",
        "--project",
        "unit",
        "--project",
        "cua-placeholder",
      ]);
    }
  });
}

test("transport failure retains receipt; retry and direct Git reuse exactly one full validation", async (t) => {
  const f = await fixture(t);
  const failed = f.push(join(f.directory, "missing-remote.git"), "main");
  assert.notEqual(failed.status, 0);
  assert(failed.stdout.includes('"step":"transport","outcome":"failed"'));
  assert.equal((await f.receipts()).length, 1);
  const retried = f.push("origin", "main");
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert(retried.stdout.includes('"outcome":"reused"'));
  assert.equal(f.run("git", ["push", "origin", "main"]).status, 0);
  assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 1);
});

test("raw Git without receipt fails fast without starting checks", async (t) => {
  const f = await fixture(t);
  const result = f.run("git", ["push", "origin", "main"]);
  assert.notEqual(result.status, 0);
  assert(result.stdout.includes("verification_receipt_required"));
  assert.deepEqual(await f.rows(), []);
  assert.notEqual(f.published().status, 0);
});

for (const change of ["tree", "tool", "installation", "environment"]) {
  test(`${change} change invalidates success`, async (t) => {
    const f = await fixture(t);
    assert.equal(f.push("origin", "main").status, 0);
    if (change === "tree") {
      await writeFile(join(f.checkout, "source.txt"), "new source");
      f.git("add", ".");
      f.git("commit", "-m", "changed source");
    } else if (change === "tool") await writeFile(join(f.checkout, ".git/tool-version"), "tool-2");
    else if (change === "installation")
      await writeFile(join(f.checkout, ".git/installation"), "deps-2");
    else f.env.CONTRACT_ENV = "new";
    const result = f.push("origin", "main");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 2);
  });
}

test("equivalent source tree in new commit reuses success", async (t) => {
  const f = await fixture(t);
  assert.equal(f.push("origin", "main").status, 0);
  f.git("commit", "--allow-empty", "-m", "metadata only");
  assert.equal(f.push("origin", "main").status, 0);
  assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 1);
});

for (const mutation of ["MUTATE_SOURCE", "MUTATE_TOOL"]) {
  test(`${mutation} during verification cannot issue a receipt`, async (t) => {
    const f = await fixture(t);
    f.env[mutation] = "1";
    assert.notEqual(f.push("origin", "main").status, 0);
    assert.equal((await f.receipts()).length, 0);
    assert.notEqual(f.published().status, 0);
  });
}

test("dirty worktree, unsupported refs and hook bypass cannot consume success", async (t) => {
  const f = await fixture(t);
  assert.equal(f.push("origin", "main").status, 0);
  const original = f.git("rev-parse", "HEAD");
  await writeFile(join(f.checkout, "new.txt"), "untracked");
  assert.notEqual(f.push("origin", "main").status, 0);
  f.git("add", ".");
  f.git("commit", "-m", "next");
  assert.notEqual(f.push("--no-verify", "origin", "main").status, 0);
  assert.equal(f.push("origin", "main").status, 0);
  assert.notEqual(f.run("git", ["push", "origin", `${original}:refs/heads/old`]).status, 0);
  f.env.HUSKY = "0";
  assert.notEqual(f.push("origin", "main").status, 0);
});

test("forced failed revalidation revokes old success", async (t) => {
  const f = await fixture(t);
  assert.equal(f.push("origin", "main").status, 0);
  f.env.UNIT_CODE = "7";
  assert.notEqual(f.push("--force-verify", "origin", "main").status, 0);
  assert.equal((await f.receipts()).length, 0);
  assert.notEqual(f.run("git", ["push", "origin", "main"]).status, 0);
});

test("another validation lock is preserved and prevents concurrent checks", async (t) => {
  const f = await fixture(t);
  const lock = join(f.checkout, ".git/verified-push/lock");
  await mkdir(lock, { recursive: true });
  const result = f.push("origin", "main");
  assert.notEqual(result.status, 0);
  assert(result.stdout.includes("verification_already_running"));
  assert.deepEqual(await f.rows(), []);
  assert.deepEqual(await readdir(lock), []);
});

test("uninitialized or dirty recursive submodule cannot be validated", async (t) => {
  const f = await fixture(t);
  assert.equal(f.push("origin", "main").status, 0);
  f.git("--git-dir", f.remote, "symbolic-ref", "HEAD", "refs/heads/main");
  f.git("-c", "protocol.file.allow=always", "submodule", "add", f.remote, "dependency");
  f.git("add", ".");
  f.git("commit", "-m", "submodule input");
  assert.equal(f.push("origin", "main").status, 0);
  await writeFile(join(f.checkout, "dependency/untracked.txt"), "dirty child");
  assert.notEqual(f.push("origin", "main").status, 0);
  await rm(join(f.checkout, "dependency/untracked.txt"));
  f.git("submodule", "deinit", "-f", "dependency");
  const result = f.push("origin", "main");
  assert.notEqual(result.status, 0);
  assert(result.stdout.includes("submodule_checkout_mismatch"));
});

test(
  "remote closes during hook: SIGPIPE is reported and retry reuses validation",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const receiver = join(f.checkout, ".git/close-receiver.mjs");
    await writeFile(
      receiver,
      `#!${process.execPath}
import { spawnSync } from 'node:child_process';
spawnSync('git',['receive-pack','--advertise-refs',process.argv[2]],{stdio:'inherit'});
`,
    );
    await chmod(receiver, 0o755);
    const failed = f.push(`--receive-pack=${receiver}`, "origin", "main");
    assert.equal(failed.status, 141, failed.stdout + failed.stderr);
    assert(failed.stdout.includes('"step":"transport","outcome":"failed","exit_code":141'));
    assert.notEqual(f.published().status, 0);
    const retried = f.push("origin", "main");
    assert.equal(retried.status, 0, retried.stdout + retried.stderr);
    assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 1);
  },
);

test("signal failure and unavailable tools never issue success", async (t) => {
  const f = await fixture(t);
  f.env.UNIT_SIGNAL = "1";
  const interrupted = f.push("origin", "main");
  assert.notEqual(interrupted.status, 0);
  assert.equal((await f.receipts()).length, 0);
  assert.notEqual(f.published().status, 0);
  delete f.env.UNIT_SIGNAL;
  assert.equal(f.push("origin", "main").status, 0);
  await rm(join(f.checkout, ".git/tool-version"));
  const unavailable = f.push("origin", "main");
  assert.notEqual(unavailable.status, 0);
  assert(unavailable.stdout.includes("toolchain_unavailable"));
  assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 2);
});

test(
  "failed validation never opens receive-pack",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = await fixture(t);
    const receiver = join(f.checkout, ".git/receiver.mjs");
    const marker = join(f.checkout, ".git/connection-opened");
    await writeFile(
      receiver,
      `#!${process.execPath}
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(marker)}, 'opened');
process.exit(23);
`,
    );
    await chmod(receiver, 0o755);
    f.env.UNIT_CODE = "7";
    const failed = f.push(`--receive-pack=${receiver}`, "origin", "main");
    assert.notEqual(failed.status, 0);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
    assert.equal((await f.receipts()).length, 0);
  },
);

test("untrusted correlation input cannot become a path or log payload", async (t) => {
  const f = await fixture(t);
  f.env.VERIFIED_PUSH_CORRELATION_ID = "../../private-correlation-payload";
  const result = f.push("origin", "main");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert(!result.stdout.includes("private-correlation-payload"));
  const events = result.stdout
    .split("\n")
    .filter((line) => line.startsWith('{"event":"engineering.git.push"'))
    .map(JSON.parse);
  assert.equal(new Set(events.map(({ correlation_id }) => correlation_id)).size, 1);
});

// 合成 SSH 只替换网络边界，真实 Git packet-line / hook / ref 更新均沿正式入口。
async function automaticSsh(f) {
  const binary = join(f.checkout, ".git/ssh-bin");
  await mkdir(binary);
  const executable = join(binary, "ssh");
  await writeFile(
    executable,
    `#!${process.execPath}
import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const args=process.argv.slice(2);
if(args.includes('-G')) process.exit(0);
const command=args.at(-1)??'';
const push=command.startsWith('git-receive-pack ');
fs.appendFileSync(process.env.SSH_TRACE,JSON.stringify({push,verified:fs.existsSync('.git/steps.jsonl')})+'\\n');
if(process.env.SSH_FAIL==='1') process.exit(23);
const result=spawnSync('git',[push?'receive-pack':'upload-pack',process.env.SSH_REMOTE],{stdio:'inherit'});
process.exit(result.status??1);
`,
  );
  await chmod(executable, 0o755);
  Object.assign(f.env, {
    PATH: binary + (process.platform === "win32" ? ";" : ":") + f.env.PATH,
    SSH_REMOTE: f.remote,
    SSH_TRACE: join(f.checkout, ".git/ssh-trace.jsonl"),
  });
  f.git("remote", "set-url", "origin", "synthetic.example:repository");
  const installed = f.run(process.execPath, ["scripts/verified-push.mjs", "install"]);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  return async () => {
    try {
      return (await readFile(f.env.SSH_TRACE, "utf8")).trim().split("\n").map(JSON.parse);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
}

test("plain git push automatically validates before SSH and preserves protocol stdout", async (t) => {
  const f = await fixture(t);
  const trace = await automaticSsh(f);
  const result = f.run("git", ["push", "origin", "main"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.published().stdout.trim(), f.git("rev-parse", "HEAD"));
  assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 1);
  assert((await trace()).every(({ verified }) => verified));
  assert(result.stderr.includes('"step":"verification","outcome":"passed"'));
  const repeated = f.run("git", ["push", "origin", "main"]);
  assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
  assert(repeated.stderr.includes('"outcome":"reused"'));
  assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 1);
});

test("plain push validation failure never opens SSH connection", async (t) => {
  const f = await fixture(t);
  const trace = await automaticSsh(f);
  f.env.UNIT_CODE = "7";
  const failed = f.run("git", ["push", "origin", "main"]);
  assert.notEqual(failed.status, 0);
  assert.deepEqual(await trace(), []);
  assert.equal((await f.receipts()).length, 0);
  assert.notEqual(f.published().status, 0);
});

test("plain push SSH failure is retried with no repeated full validation", async (t) => {
  const f = await fixture(t);
  await automaticSsh(f);
  f.env.SSH_FAIL = "1";
  assert.notEqual(f.run("git", ["push", "origin", "main"]).status, 0);
  assert.equal((await f.receipts()).length, 1);
  delete f.env.SSH_FAIL;
  const retried = f.run("git", ["push", "origin", "main"]);
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert(retried.stderr.includes('"outcome":"reused"'));
  assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 1);
});

test("plain push revalidates a changed source tree", async (t) => {
  const f = await fixture(t);
  await automaticSsh(f);
  assert.equal(f.run("git", ["push", "origin", "main"]).status, 0);
  await writeFile(join(f.checkout, "next.txt"), "new code");
  f.git("add", ".");
  f.git("commit", "-m", "next source");
  assert.equal(f.run("git", ["push", "origin", "main"]).status, 0);
  assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 2);
});

test("fetch and SSH probes bypass validation even without current-branch verifier", async (t) => {
  const f = await fixture(t);
  const trace = await automaticSsh(f);
  assert.equal(f.run("git", ["ls-remote", "origin"]).status, 0);
  assert.deepEqual(await f.rows(), []);
  assert((await trace()).every(({ push }) => !push));
  assert.equal(f.run("git", ["push", "origin", "main"]).status, 0);
  const before = await f.rows();
  await rm(join(f.checkout, "scripts/verified-push.mjs"));
  const fetched = f.run("git", ["fetch", "origin", "main"]);
  assert.equal(fetched.status, 0, fetched.stderr);
  assert.deepEqual(await f.rows(), before);
});

test("automatic installation is idempotent and does not replace external SSH settings", async (t) => {
  const f = await fixture(t);
  await automaticSsh(f);
  assert.equal(f.run(process.execPath, ["scripts/verified-push.mjs", "check-install"]).status, 0);
  assert.equal(f.run(process.execPath, ["scripts/verified-push.mjs", "install"]).status, 0);
  f.git("config", "core.sshCommand", "custom-ssh -o user-option");
  const rejected = f.run(process.execPath, ["scripts/verified-push.mjs", "install"]);
  assert.notEqual(rejected.status, 0);
  assert.equal(f.git("config", "--get", "core.sshCommand"), "custom-ssh -o user-option");
});

test("ordinary git push uses installed Node even if ambient node fails", async (t) => {
  const f = await fixture(t);
  await automaticSsh(f);
  await writeFile(join(f.checkout, ".git/ssh-bin/node"), "#!/bin/sh\nexit 97\n");
  await chmod(join(f.checkout, ".git/ssh-bin/node"), 0o755);
  const pushed = f.run("git", ["push", "origin", "main"]);
  assert.equal(pushed.status, 0, pushed.stdout + pushed.stderr);
  assert.equal(f.published().stdout.trim(), f.git("rev-parse", "HEAD"));
});

test("explicit SSH environment override is diagnosed without replacing configuration", async (t) => {
  const f = await fixture(t);
  await automaticSsh(f);
  const configured = f.git("config", "--get", "core.sshCommand");
  f.env.GIT_SSH_COMMAND = "external-ssh private-option-must-not-be-logged";
  const refused = f.run(process.execPath, ["scripts/verified-push.mjs", "install"]);
  assert.notEqual(refused.status, 0);
  assert(refused.stdout.includes("ssh_environment_override_requires_integration"));
  assert(!(refused.stdout + refused.stderr).includes("private-option-must-not-be-logged"));
  assert.equal(f.git("config", "--get", "core.sshCommand"), configured);
});

test("server ref rejection remains a failed Git push even when SSH closes normally", async (t) => {
  const f = await fixture(t);
  await automaticSsh(f);
  const hook = join(f.remote, "hooks/pre-receive");
  await writeFile(hook, "#!/bin/sh\nexit 1\n");
  await chmod(hook, 0o755);
  const rejected = f.run("git", ["push", "origin", "main"]);
  assert.notEqual(rejected.status, 0);
  assert.notEqual(f.published().status, 0);
  assert(rejected.stderr.includes('"step":"ssh","outcome":"closed"'));
  assert(!rejected.stderr.includes('"step":"transport","outcome":"passed"'));
  await rm(hook);
  const retried = f.run("git", ["push", "origin", "main"]);
  assert.equal(retried.status, 0, retried.stdout + retried.stderr);
  assert.equal((await f.rows()).filter(({ step }) => step === "unit").length, 1);
});

test("source archive prepare skips Git installation while admission still fails", async (t) => {
  const f = await fixture(t);
  await rm(join(f.checkout, ".git"), { recursive: true });
  const installed = f.run(process.execPath, ["scripts/verified-push.mjs", "install"]);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert(installed.stdout.includes('"reason_code":"not_a_git_checkout"'));
  assert.notEqual(
    f.run(process.execPath, ["scripts/verified-push.mjs", "check-install"]).status,
    0,
  );
  assert.notEqual(f.push("origin", "main").status, 0);
});

test("HUSKY=0 prepare skips configuration without allowing a disabled push gate", async (t) => {
  const f = await fixture(t);
  f.env.HUSKY = "0";
  const installed = f.run(process.execPath, ["scripts/verified-push.mjs", "install"]);
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  assert(installed.stdout.includes('"reason_code":"hooks_explicitly_disabled"'));
  assert.equal(f.run("git", ["config", "--get", "core.sshCommand"]).status, 1);
  assert.notEqual(
    f.run(process.execPath, ["scripts/verified-push.mjs", "check-install"]).status,
    0,
  );
  const pushed = f.push("origin", "main");
  assert.notEqual(pushed.status, 0);
  assert(pushed.stdout.includes("push_hook_not_enabled"));
  assert.deepEqual(await f.rows(), []);
  assert.notEqual(f.published().status, 0);
});
