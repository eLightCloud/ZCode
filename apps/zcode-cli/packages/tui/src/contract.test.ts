import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { runTui, type TuiOptions } from "./contract.js";

test("non-interactive entry rejects before initializing the application", async () => {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let initialized = false;
  const code = await runTui({
    stdin: stdin as unknown as TuiOptions["stdin"],
    stdout: stdout as unknown as TuiOptions["stdout"],
    stderr: stderr as unknown as TuiOptions["stderr"],
    noColor: true,
    locale: "en-US",
    applicationName: "Example Application",
    submitPrompt: async () => ({ response: "" }),
    loadStartupOptions: async () => {
      initialized = true;
      return {};
    },
  });
  assert.equal(code, 1);
  assert.equal(initialized, false);
  assert.equal(stdout.read(), null);
  assert.ok(stderr.read());
  stdin.destroy();
  stdout.destroy();
  stderr.destroy();
});
