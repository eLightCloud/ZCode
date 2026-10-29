import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
const state = vi.hoisted(() => ({
  directory: "",
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
afterEach(async () => {
  state.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await rm(state.directory, { force: true, recursive: true });
});
it("binds each native call to the current Electron app cookie and rejects logout or an untrusted caller", async () => {
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
  const { applicationModelBrokerEnvironment } =
    await import("../src/main/applicationModelBroker.js");
  const env = applicationModelBrokerEnvironment();
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
});
