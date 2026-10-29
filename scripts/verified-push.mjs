#!/usr/bin/env node
// Git 在 pre-push 前已经连接远端；长验证前置，hook 只核验同输入成功凭证。
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = (value) => createHash("sha256").update(value).digest("hex");
class Rejected extends Error {}

async function run(command, args, { cwd, env, capture = false, group = false } = {}) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: group && process.platform !== "win32",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    if (capture) {
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      // 工具异常可能带本机路径或秘密；只向外报告稳定原因，不转发捕获的 stderr。
      child.stderr.resume();
    }
    const handlers = ["SIGINT", "SIGTERM"].map((signal) => {
      const handler = () => {
        // 验证拥有整个子进程树；取消后不能遗留仍在跑的全量测试或签发凭证。
        if (group && process.platform !== "win32" && child.pid) {
          try {
            process.kill(-child.pid, signal);
          } catch (error) {
            if (error.code !== "ESRCH") throw error;
          }
        } else child.kill(signal);
      };
      process.on(signal, handler);
      return [signal, handler];
    });
    const cleanup = () => handlers.forEach(([signal, handler]) => process.off(signal, handler));
    child.once("error", () => {
      cleanup();
      reject(new Rejected("command_unavailable"));
    });
    child.once("close", (code, signal) => {
      cleanup();
      done({ code: code ?? 128 + (osConstants.signals[signal] ?? 1), stdout });
    });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const inheritedId = process.env.VERIFIED_PUSH_CORRELATION_ID ?? "";
  // 关联标识仅接受 UUID，不能把任意继承环境内容写进日志或临时文件名。
  const id = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(inheritedId)
    ? inheritedId
    : randomUUID();
  const report = (step, outcome, fields = {}) =>
    console.log(
      JSON.stringify({
        event: "engineering.git.push",
        event_schema_version: 1,
        correlation_id: id,
        step,
        outcome,
        ...fields,
      }),
    );
  let lock;
  let root;
  try {
    const [action, ...supplied] = argv;
    if (!["push", "check"].includes(action)) throw new Rejected("use_push_or_check");
    const env = { ...process.env };
    const local = await run("git", ["rev-parse", "--local-env-vars"], { capture: true });
    if (local.code) throw new Rejected("repository_required");
    // 防止 hook 注入的 Git 变量污染验证创建的临时仓库。
    for (const name of local.stdout.trim().split(/\r?\n/)) delete env[name];
    const git = async (...args) => {
      const result = await run("git", args, { cwd: root, env, capture: true });
      if (result.code) throw new Rejected("git_inspection_failed");
      return result.stdout.trimEnd();
    };
    root = await git("rev-parse", "--show-toplevel");
    const policy = JSON.parse(await readFile(resolve(root, ".push-verification.json"), "utf8"));
    const commandValid = (command) =>
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((part) => typeof part === "string" && part.length > 0);
    if (
      policy.version !== 1 ||
      !commandValid(policy.verify) ||
      !Array.isArray(policy.tools) ||
      !policy.tools.length ||
      !policy.tools.every(commandValid) ||
      !Array.isArray(policy.hookFiles) ||
      !policy.hookFiles.length ||
      !policy.hooksPath ||
      !policy.entry
    )
      throw new Rejected("invalid_verification_policy");
    const pushArgs = supplied[0] === "--" ? supplied.slice(1) : supplied;
    const force = action === "push" && pushArgs[0] === "--force-verify";
    if (force) pushArgs.shift();
    if (
      pushArgs.some(
        (arg) =>
          ["--no-verify", "--mirror", "--all", "--tags", "--follow-tags"].includes(arg) ||
          /^-[^-]*n/.test(arg),
      )
    )
      throw new Rejected("unsupported_push_option");
    if ((await git("config", "--get", "core.hooksPath")) !== policy.hooksPath || env.HUSKY === "0")
      throw new Rejected("push_hook_not_enabled");
    for (const file of policy.hookFiles) await access(resolve(root, file), constants.F_OK);
    await access(
      resolve(root, policy.hooksPath, "pre-push"),
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    const fingerprint = async () => {
      if (
        await git("status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none")
      )
        throw new Rejected("clean_committed_worktree_required");
      const submodules = await git("submodule", "status", "--recursive");
      if (submodules.split("\n").some((line) => /^[+\-U]/.test(line)))
        throw new Rejected("submodule_checkout_mismatch");
      const tools = [];
      for (const command of policy.tools) {
        const tool = await run(command[0], command.slice(1), { cwd: root, env, capture: true });
        if (tool.code) throw new Rejected("toolchain_unavailable");
        tools.push(tool.stdout);
      }
      const inputs = [];
      for (const path of policy.localInputs ?? []) {
        try {
          inputs.push([path, digest(await readFile(resolve(root, path)))]);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          inputs.push([path, null]);
        }
      }
      return digest(
        JSON.stringify({
          version: 1,
          tree: await git("rev-parse", "HEAD^{tree}"),
          policy: digest(await readFile(resolve(root, ".push-verification.json"))),
          // 分支描述不属于源码：同一 gitlink 切换 detached / branch 不应导致重验。
          submodules: submodules
            .split("\n")
            .filter(Boolean)
            .map((line) => line.slice(1).split(" ")[0]),
          platform: process.platform,
          arch: process.arch,
          node: [process.execPath, process.version],
          tools,
          inputs,
          environment: (policy.environment ?? []).map((key) => [key, env[key] ?? null]),
          implementation: digest(await readFile(fileURLToPath(import.meta.url))),
        }),
      );
    };
    const key = await fingerprint();
    const directory = resolve(root, await git("rev-parse", "--git-path", "verified-push"));
    const receipt = resolve(directory, `${key}.json`);
    let accepted = false;
    try {
      const saved = JSON.parse(await readFile(receipt, "utf8"));
      accepted = saved.version === 1 && saved.fingerprint === key && saved.outcome === "passed";
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (action === "check") {
      const input = [];
      if (process.stdin.isTTY) throw new Rejected("push_refs_required");
      for await (const data of process.stdin) input.push(data);
      const head = await git("rev-parse", "HEAD");
      for (const line of Buffer.concat(input).toString().trim().split(/\r?\n/).filter(Boolean)) {
        const parts = line.split(/\s+/);
        if (parts.length !== 4 || (!/^0+$/.test(parts[1]) && parts[1] !== head))
          throw new Rejected("only_current_head_can_be_verified");
      }
      if (!accepted) {
        console.error(`请先执行 ${policy.entry}；pre-push 不再运行耗时验证。`);
        throw new Rejected("verification_receipt_required");
      }
      report("admission", "accepted", { fingerprint: key });
      return 0;
    }
    if (!accepted || force) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      lock = resolve(directory, "lock");
      try {
        await mkdir(lock);
      } catch (error) {
        lock = undefined;
        if (error.code === "EEXIST") throw new Rejected("verification_already_running");
        throw error;
      }
      // 强制重验失败后，不能继续沿用旧成功凭证。
      await rm(receipt, { force: true });
      report("verification", "started", { fingerprint: key });
      const checked = await run(policy.verify[0], policy.verify.slice(1), {
        cwd: root,
        env,
        group: true,
      });
      if (checked.code) {
        report("verification", "failed", { exit_code: checked.code });
        return checked.code;
      }
      if ((await fingerprint()) !== key) throw new Rejected("verification_inputs_changed");
      const temporary = resolve(directory, `${key}.${id}.tmp`);
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, fingerprint: key, outcome: "passed" }),
        { mode: 0o600 },
      );
      await rename(temporary, receipt);
      report("verification", "passed", { fingerprint: key });
      await rm(lock, { recursive: true });
      lock = undefined;
    } else report("verification", "reused", { fingerprint: key });
    report("transport", "started", { fingerprint: key });
    const pushed = await run("git", ["push", ...pushArgs], {
      cwd: root,
      env: { ...env, VERIFIED_PUSH_CORRELATION_ID: id },
    });
    report("transport", pushed.code ? "failed" : "passed", { exit_code: pushed.code });
    return pushed.code;
  } catch (error) {
    report("admission", "rejected", {
      reason_code: error instanceof Rejected ? error.message : "push_setup_failed",
    });
    return 1;
  } finally {
    if (lock) await rm(lock, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main();
