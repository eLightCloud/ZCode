import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginHttpBroker } from "../src/main/applicationHttp/sourceBroker.js";
const main = vi.hoisted(() => ({
  directory: "",
  quit: undefined as (() => void) | undefined,
  cookies: [] as Array<{ name: string; value: string }>,
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => main.directory,
    once: (_name: string, callback: () => void) => {
      main.quit = callback;
    },
  },
  BrowserWindow: {},
  ipcMain: {},
  session: {
    defaultSession: {
      cookies: { get: async () => main.cookies },
      fetch: () => {
        throw new Error("Electron rejects explicit Origin");
      },
    },
  },
}));
import { initializeApplicationPluginHttp } from "../src/main/applicationHttp/index.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
});

it("initializes Main native acquisition using Node fetch and current allowlisted application cookies", async () => {
  main.directory = await mkdtemp(join(tmpdir(), "plugin-http-main-test-"));
  cleanup.push(() => rm(main.directory, { recursive: true, force: true }));
  const upstream = createServer((request, response) => {
    const allowed =
      request.headers.cookie === "owned-session=synthetic-owned" &&
      request.headers.origin === "http://localhost:3105";
    response.writeHead(allowed ? 200 : 401);
    response.end(allowed ? "owned-package" : "unauthorized");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        upstream.closeAllConnections();
        upstream.close(() => resolve());
      }),
  );
  const address = upstream.address() as { port: number };
  vi.stubEnv(
    "ZCODE_APPLICATION_ACCOUNT_API",
    `http://127.0.0.1:${address.port}`,
  );
  vi.stubEnv("ZCODE_APPLICATION_PUBLIC_ORIGIN", "http://localhost:3105");
  vi.stubEnv("ZCODE_APPLICATION_API_PREFIXES", "/api/enterprise");
  vi.stubEnv("ZCODE_APPLICATION_CSRF_COOKIE", "synthetic-csrf");
  vi.stubEnv("ZCODE_APPLICATION_CSRF_HEADER", "X-CSRF-Token");
  vi.stubEnv("ZCODE_APPLICATION_SESSION_COOKIES", "owned-session");
  vi.stubEnv(
    "ZCODE_APPLICATION_PLUGIN_HTTP_SOURCES",
    JSON.stringify([
      {
        origin: "http://localhost:3100",
        pathPrefix: "/api/enterprise/plugins/",
      },
    ]),
  );
  vi.stubEnv("ZCODE_PLUGIN_SOURCE_CREDENTIALS_FILE", "");
  main.cookies = [
    { name: "owned-session", value: "synthetic-owned" },
    { name: "unrelated", value: "excluded" },
  ];
  await initializeApplicationPluginHttp({
    logger: { info: () => undefined, warn: () => undefined },
  });
  const credentialFile = process.env.ZCODE_PLUGIN_SOURCE_CREDENTIALS_FILE!;
  const {
    bindings: [binding],
  } = JSON.parse(await readFile(credentialFile, "utf8"));
  const url = binding.transportOrigin + "/api/enterprise/plugins/owned/package";
  const headers = { Authorization: "Bearer " + binding.token };
  expect(await (await fetch(url, { headers })).text()).toBe("owned-package");
  main.cookies = [];
  expect((await fetch(url, { headers })).status).toBe(401);
  main.quit!();
  await vi.waitFor(async () =>
    expect(await stat(credentialFile).catch(() => null)).toBeNull(),
  );
});

it("authenticates native acquisition, keeps account credentials private and rechecks the current session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plugin-http-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let loggedIn = true;
  const fetchUpstream = vi.fn(async (_url: string, input: RequestInit) => {
    expect(input.credentials).toBe("include");
    expect(input.redirect).toBe("error");
    expect(input.headers).toEqual({ Origin: "https://app.invalid" });
    return new Response(loggedIn ? "package-bytes" : "unauthorized", {
      status: loggedIn ? 200 : 401,
    });
  });
  const logger = { info: vi.fn(), warn: vi.fn() };
  const broker = await createPluginHttpBroker({
    directory,
    logger,
    configuration: {
      apiOrigin: "https://api.invalid",
      publicOrigin: "https://app.invalid",
      prefixes: ["/api/enterprise"],
      csrfCookie: "synthetic-csrf",
      csrfHeader: "X-CSRF-Token",
    },
    sources: [
      {
        origin: "https://catalog.invalid",
        pathPrefix: "/api/enterprise/plugins/",
      },
    ],
    transport: { cookies: { get: async () => [] }, fetch: fetchUpstream },
  });
  cleanup.push(broker.dispose);
  const raw = await readFile(broker.credentialFile, "utf8");
  const {
    bindings: [binding],
  } = JSON.parse(raw);
  if (process.platform !== "win32")
    expect((await stat(broker.credentialFile)).mode & 0o777).toBe(0o600);
  expect(raw).not.toContain("Cookie");
  const path = "/api/enterprise/plugins/owned/marketplace.json?version=fixed";
  const url = binding.transportOrigin + path;
  expect((await fetch(url)).status).toBe(401);
  const headers = { Authorization: "Bearer " + binding.token };
  expect(
    (
      await fetch(binding.transportOrigin + "/api/enterprise/billing", {
        headers,
      })
    ).status,
  ).toBe(403);
  expect((await fetch(url, { headers, method: "POST" })).status).toBe(403);
  expect(fetchUpstream).not.toHaveBeenCalled();
  expect(await (await fetch(url, { headers })).text()).toBe("package-bytes");
  expect(fetchUpstream.mock.calls[0]![0]).toBe("https://api.invalid" + path);
  loggedIn = false;
  expect((await fetch(url, { headers })).status).toBe(401);
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain(binding.token);
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain(path);
});

it("closes acquisition on redirect failure and disposes its listener and credential file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plugin-http-test-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const broker = await createPluginHttpBroker({
    directory,
    logger: { info: () => undefined, warn: () => undefined },
    configuration: {
      apiOrigin: "https://api.invalid",
      publicOrigin: "https://app.invalid",
      prefixes: ["/api/enterprise"],
      csrfCookie: "synthetic-csrf",
      csrfHeader: "X-CSRF-Token",
    },
    sources: [
      {
        origin: "https://catalog.invalid",
        pathPrefix: "/api/enterprise/plugins/",
      },
    ],
    transport: {
      cookies: { get: async () => [] },
      fetch: async () => {
        throw new TypeError("redirect");
      },
    },
  });
  const {
    bindings: [binding],
  } = JSON.parse(await readFile(broker.credentialFile, "utf8"));
  const url = binding.transportOrigin + "/api/enterprise/plugins/owned/package";
  expect(
    (
      await fetch(url, {
        headers: { Authorization: "Bearer " + binding.token },
      })
    ).status,
  ).toBe(503);
  await broker.dispose();
  await expect(stat(broker.credentialFile)).rejects.toThrow();
  await expect(fetch(url)).rejects.toThrow();
});
