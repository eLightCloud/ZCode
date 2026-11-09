import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
const state = vi.hoisted(() => ({
  directory: "",
  bundledPath: "",
  cookies: [] as { name: string; value: string }[],
  close: () => {},
}));
vi.mock("electron", () => ({
  app: {
    getPath: () => state.directory,
    once: (_event: string, callback: () => void) => {
      state.close = callback;
    },
  },
  session: { defaultSession: { cookies: { get: async () => state.cookies } } },
}));
vi.mock("../src/main/desktopProviderConfig.js", () => ({
  resolveZCodeBuiltinProviderConfigFilePath: () => state.bundledPath,
}));
afterEach(async () => {
  state.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(state.directory, { force: true, recursive: true });
});
beforeEach(async () => {
  vi.resetModules();
  state.close = () => {};
  state.cookies = [];
  state.bundledPath = fileURLToPath(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
  );
  state.directory = await mkdtemp(join(tmpdir(), "application-model-broker-"));
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  for (const [key, value] of Object.entries({
    ZCODE_APPLICATION_MODEL_REMOTE_BASE_URL: "http://127.0.0.1:3101/api/system-models/v1",
    ZCODE_APPLICATION_MODEL_REMOTE_CONFIG_URL:
      "http://127.0.0.1:3101/api/system-models/native/config",
    ZCODE_APPLICATION_PUBLIC_ORIGIN: "http://localhost:3105",
    ZCODE_APPLICATION_CSRF_COOKIE: "synthetic-csrf",
    ZCODE_APPLICATION_CSRF_HEADER: "X-CSRF-Token",
    ZCODE_APPLICATION_SESSION_COOKIES: "synthetic-session,synthetic-csrf",
    ZCODE_APPLICATION_MODEL_ACCOUNT_HEADER: "X-Synthetic-Account",
    ZCODE_APPLICATION_MODEL_BROKER_PORT: String(port),
  }))
    vi.stubEnv(key, value);
});
it("retains bundled templates while binding calls to the current cookie and rejecting unauthorized callers", async () => {
  const originalFetch = globalThis.fetch;
  const upstream = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Response(
        JSON.stringify({
          cookie: new Headers(init?.headers).get("Cookie"),
          scope: new Headers(init?.headers).get("X-Synthetic-Account"),
        }),
        {
          headers: { "content-type": "application/json" },
        },
      ),
  );
  vi.stubGlobal("fetch", upstream);
  const { applicationModelBrokerEnvironment, initializeApplicationModelBroker } =
    await import("../src/main/applicationModelBroker.js");
  await initializeApplicationModelBroker();
  const env = applicationModelBrokerEnvironment();
  const baseline = JSON.parse(await readFile(env.ZCODE_APPLICATION_PROVIDER_CONFIG_FILE, "utf8"));
  const bundled = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  // 启动期阻断未授权企业模型，不应同时抹掉自定义供应商模板及模型能力。
  expect(baseline.config.providerConfigRules.templateRules).toEqual(
    bundled.config.providerConfigRules.templateRules,
  );
  expect(baseline.config.modelConfigRules).toEqual(bundled.config.modelConfigRules);
  expect(baseline.config.providerConfigRules.providerRules).toEqual([]);
  expect(baseline.applicationDefault.providerId).toBe("application:unavailable");
  await new Promise((resolve) => setImmediate(resolve));
  const call = () =>
    originalFetch(env.ZCODE_APPLICATION_MODEL_BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.ZCODE_APPLICATION_MODEL_TOKEN,
        "X-Synthetic-Account": "fixed-original-person",
      },
      body: "{}",
    });
  state.cookies = [
    { name: "synthetic-session", value: "person-one" },
    { name: "synthetic-csrf", value: "csrf-one" },
  ];
  expect(((await (await call()).json()) as { cookie: string }).cookie).toContain("person-one");
  state.cookies = [
    { name: "synthetic-session", value: "person-two" },
    { name: "synthetic-csrf", value: "csrf-two" },
  ];
  expect(((await (await call()).json()) as { cookie: string }).cookie).toContain("person-two");
  expect(new Headers(upstream.mock.calls.at(-1)?.[1]?.headers).get("Origin")).toBe(
    "http://localhost:3105",
  );
  state.cookies = [];
  expect((await call()).status).toBe(401);
  expect(
    (
      await originalFetch(env.ZCODE_APPLICATION_MODEL_BASE_URL + "/chat/completions", {
        method: "POST",
        headers: { Authorization: "Bearer synthetic-wrong-credential" },
        body: "{}",
      })
    ).status,
  ).toBe(401);
  expect(upstream).toHaveBeenCalledTimes(2);
  expect(env.ZCODE_APPLICATION_MODEL_AUTOMATION).toBe("user");
  expect(new Headers(upstream.mock.calls[0]?.[1]?.headers).get("X-Synthetic-Account")).toBe(
    "fixed-original-person",
  );
  state.cookies = [
    { name: "synthetic-session", value: "person-two" },
    { name: "synthetic-csrf", value: "csrf-two" },
  ];
  const missing = await originalFetch(env.ZCODE_APPLICATION_MODEL_BASE_URL + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.ZCODE_APPLICATION_MODEL_TOKEN },
    body: "{}",
  });
  expect(missing.status).toBe(403);
  expect(upstream).toHaveBeenCalledTimes(2);
  upstream.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  const refresh = () =>
    originalFetch(env.ZCODE_APPLICATION_MODEL_CONFIG_URL, {
      headers: { Authorization: "Bearer " + env.ZCODE_APPLICATION_MODEL_TOKEN },
    });
  expect((await refresh()).status).toBe(503);
  expect(JSON.parse(await readFile(env.ZCODE_APPLICATION_PROVIDER_CONFIG_FILE, "utf8"))).toEqual(
    baseline,
  );
  upstream.mockResolvedValueOnce(new Response(JSON.stringify(baseline)));
  const refreshed = await (await refresh()).json();
  expect(refreshed.config.providerConfigRules.templateRules).toEqual(
    baseline.config.providerConfigRules.templateRules,
  );
  expect(refreshed.config.modelConfigRules).toEqual(baseline.config.modelConfigRules);
});
it("rejects malformed bundled config and reports a low-sensitivity reason before starting any Host", async () => {
  state.bundledPath = join(state.directory, "invalid.json");
  await writeFile(state.bundledPath, "{}");
  const { initializeApplicationModelBroker, applicationModelBrokerEnvironment } =
    await import("../src/main/applicationModelBroker.js");
  const logger = { info: vi.fn(), warn: vi.fn() };
  await expect(initializeApplicationModelBroker(logger)).rejects.toThrow(
    "application_model_bundled_provider_config_invalid",
  );
  expect(logger.warn).toHaveBeenCalledWith("application.model.baseline", {
    outcome: "failed",
    reason_code: "bundled_provider_config_invalid",
  });
  expect(applicationModelBrokerEnvironment).toThrow("application_model_broker_not_initialized");
});
