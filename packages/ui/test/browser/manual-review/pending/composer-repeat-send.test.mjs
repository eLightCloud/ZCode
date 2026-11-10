import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("../../../../../../", import.meta.url));
const entry = "/packages/ui/test/browser/manual-review/pending/composer-repeat-send.fixture.tsx";
let server, browser, origin;
before(async () => {
  server = await createServer({
    root,
    configFile: false,
    plugins: [
      {
        name: "repeat-send-fixture",
        enforce: "pre",
        // 隔离目录服务与设置读取；键位解析、Lexical 和草稿编辑使用实际实现。
        resolveId(id, importer) {
          if (!importer?.endsWith("/LexicalChatInput.tsx")) return;
          if (/SlashCommandPlugin|MentionPlugin|activeTaskProvider|useShortcutBindings/.test(id))
            return "\0repeat-send-dependencies";
        },
        load(id) {
          if (id !== "\0repeat-send-dependencies") return;
          return `
            export const SlashCommandPlugin = () => null;
            export const MentionPlugin = () => null;
            export const useChatViewActiveTaskProvider = () => "zcode";
            export const useEffectiveShortcutBindings = () => ({
              composerSend: [new URLSearchParams(location.search).get("binding") || "Enter"],
              composerInsertNewline: ["Shift+Enter"]
            });`;
        },
        configureServer(vite) {
          vite.middlewares.use(async (req, res, next) => {
            if (!req.url?.startsWith("/fixture?")) return next();
            res.setHeader("Content-Type", "text/html");
            res.end(
              await vite.transformIndexHtml(
                req.url,
                `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
              ),
            );
          });
        },
      },
      react(),
    ],
    resolve: { alias: { "@": `${root}packages/ui/src` } },
    optimizeDeps: { entries: [entry.slice(1)] },
    server: { host: "127.0.0.1", port: 0, hmr: false },
  });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch(
    process.env.CHROME_EXECUTABLE_PATH
      ? { executablePath: process.env.CHROME_EXECUTABLE_PATH }
      : { channel: "chrome" },
  );
});
after(async () => {
  await browser?.close();
  await server?.close();
});

async function withEditor(params, run) {
  const page = await browser.newPage({
    viewport: { width: params.mode === "mobile" ? 430 : 1250, height: 800 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.setDefaultTimeout(10_000);
  const state = async () => JSON.parse(await page.getByTestId("state").textContent());
  try {
    await page.goto(`${origin}fixture?${new URLSearchParams(params)}`, { timeout: 60_000 });
    const editor = page.getByTestId("editor");
    await editor.fill("测试发送内容");
    await page.waitForFunction(
      () =>
        JSON.parse(document.querySelector('[data-testid="state"]').textContent).text ===
        "测试发送内容",
    );
    await run({ page, editor, state });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

for (const [label, params, key] of [
  ["Enter", {}, "Enter"],
  ["rebound Ctrl+Enter", { binding: "Ctrl+Enter" }, "Control+Enter"],
  ["modified Ctrl+Enter", { mode: "modified" }, "Control+Enter"],
  ["modified Meta+Enter", { mode: "modified" }, "Meta+Enter"],
  ["rebound non-Enter key", { binding: "F9" }, "F9"],
]) {
  test(`repeat ${label}: send once and clear after acceptance`, () =>
    withEditor(params, async ({ page, editor, state }) => {
      await editor.press(key);
      await page.waitForFunction(
        () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).pending,
      );
      await editor.press(key);
      assert.deepEqual(await state(), {
        pending: true,
        count: 1,
        text: "测试发送内容",
        sent: "测试发送内容",
      });
      await page.getByRole("button", { name: "Accept" }).click();
      await page.waitForFunction(
        () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).text === "",
      );
      // Lexical 空段落保留 <br>，innerText 会投影为换行；正文与文本节点都应为空。
      assert.equal(await editor.textContent(), "");
    }));
}

test("two immediate Enter events before React commits send once and clear", () =>
  withEditor({}, async ({ page, editor, state }) => {
    await editor.evaluate((element) => {
      element.focus();
      for (let index = 0; index < 2; index += 1) {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
        element.dispatchEvent(
          new KeyboardEvent("keyup", {
            key: "Enter",
            code: "Enter",
            bubbles: true,
          }),
        );
      }
    });
    assert.deepEqual(await state(), {
      pending: true,
      count: 1,
      text: "测试发送内容",
      sent: "测试发送内容",
    });
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForFunction(
      () => JSON.parse(document.querySelector('[data-testid="state"]').textContent).text === "",
    );
    assert.equal(await editor.textContent(), "");
  }));

test("explicit newline and new edits survive a late acceptance", () =>
  withEditor({}, async ({ page, editor, state }) => {
    await editor.press("Enter");
    await editor.press("Shift+Enter");
    await page.keyboard.insertText("新增文字");
    const edited = (await state()).text;
    assert.match(edited, /测试发送内容\n+新增文字/);
    await page.getByRole("button", { name: "Accept" }).click();
    assert.equal((await state()).text, edited);
    assert.equal((await state()).count, 1);
  }));

test("rejection retains the original draft after repeated Enter", () =>
  withEditor({}, async ({ page, editor, state }) => {
    await editor.press("Enter");
    await editor.press("Enter");
    await page.getByRole("button", { name: "Reject" }).click();
    assert.equal((await state()).text, "测试发送内容");
    assert.equal((await state()).count, 1);
  }));

for (const params of [{ mode: "mobile" }, { binding: "Ctrl+Enter" }]) {
  test(`bare Enter remains newline: ${JSON.stringify(params)}`, () =>
    withEditor(params, async ({ editor, state }) => {
      await editor.press("Enter");
      assert.equal((await state()).count, 0);
      assert.match((await state()).text, /测试发送内容\n/);
    }));
}
