import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { SERVER_CLI_DEFINES } from "../tsup.config.js";

it("reports the staged application version from the actual compiled shared version", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  const bundled = await build({
    stdin: {
      contents: "import { ZCODE_VERSION } from '@zcode/shared'; process.stdout.write(ZCODE_VERSION)",
      resolveDir: fileURLToPath(new URL("..", import.meta.url)),
    },
    bundle: true, write: false, platform: "node", format: "cjs",
    define: SERVER_CLI_DEFINES,
  });
  const directory = await mkdtemp(join(tmpdir(), "zcode-build-version-"));
  try {
    const script = join(directory, "compiled.cjs");
    await writeFile(script, bundled.outputFiles[0]!.text);
    const output = await promisify(execFile)(process.execPath, [script]);
    expect(output.stdout).toBe(manifest.version);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
