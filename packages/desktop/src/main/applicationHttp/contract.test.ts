import { describe, expect, it, vi } from "vitest";
import {
  applicationHttpTarget,
  applicationPluginHttpSources,
  readApplicationHttpConfiguration,
} from "./configuration.js";
import { performApplicationHttp } from "./transport.js";
const environment = {
  ZCODE_APPLICATION_ACCOUNT_API: "https://owned.invalid",
  ZCODE_APPLICATION_API_PREFIXES: "/api/profile",
  ZCODE_APPLICATION_CSRF_COOKIE: "__Host-owned-csrf",
  ZCODE_APPLICATION_CSRF_HEADER: "X-CSRF-Token",
};
const configuration = readApplicationHttpConfiguration(environment, true)!;
const input = {
  requestId: "c55266ab-2ab5-43af-94e4-39fac218cb0f",
  path: "/api/profile/me",
  method: "GET" as const,
};
describe("Main fixed application HTTP boundary", () => {
  it("reads only configured current application cookies across the development proxy host boundary", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce([
        { name: "owned-session", value: "synthetic-first" },
        { name: "unrelated", value: "excluded" },
      ])
      .mockResolvedValueOnce([]);
    const fetch = vi.fn(
      async (_url: string, _input: RequestInit) => new Response("{}"),
    );
    const config = {
      ...configuration,
      publicOrigin: "https://app.invalid",
      sessionCookies: ["owned-session"],
    };
    for (let i = 0; i < 2; i++)
      await performApplicationHttp(
        config,
        input,
        { cookies: { get }, fetch },
        new AbortController().signal,
      );
    expect(get).toHaveBeenCalledWith({ url: "https://app.invalid" });
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      credentials: "omit",
      headers: { Cookie: "owned-session=synthetic-first" },
    });
    expect(fetch.mock.calls[1]![1]).toMatchObject({
      credentials: "omit",
      headers: { Cookie: "" },
    });
  });
  it("only admits startup plugin download subtrees within the existing HTTP allowlist", () => {
    const configured = {
      ...environment,
      ZCODE_APPLICATION_API_PREFIXES: "/api/profile,/api/enterprise",
    };
    const config = readApplicationHttpConfiguration(configured, true)!;
    const sources = (origin: string, pathPrefix: string) => ({
      ZCODE_APPLICATION_PLUGIN_HTTP_SOURCES: JSON.stringify([
        { origin, pathPrefix },
      ]),
    });
    expect(applicationPluginHttpSources(config, {}, true)).toEqual([]);
    expect(
      applicationPluginHttpSources(
        config,
        sources("https://owned.invalid", "/api/enterprise/plugins/"),
        true,
      ),
    ).toEqual([
      {
        origin: "https://owned.invalid",
        pathPrefix: "/api/enterprise/plugins/",
      },
    ]);
    for (const prefix of [
      "/api/auth/",
      "/api/enterprise/",
      "/api/native/rpc/",
      "/api/platform/plugins/",
      "/api/enterprise/plugins/?",
      "/api/enterprise/../plugins/",
    ])
      expect(() =>
        applicationPluginHttpSources(
          config,
          sources("https://owned.invalid", prefix),
          true,
        ),
      ).toThrow();
    expect(() =>
      applicationPluginHttpSources(
        config,
        sources("http://localhost:3100", "/api/enterprise/plugins/"),
        true,
      ),
    ).toThrow();
  });
  it("keeps missing configuration closed and rejects packaged HTTP and secret-bearing targets", () => {
    expect(readApplicationHttpConfiguration({}, true)).toBeUndefined();
    for (const target of [
      "http://localhost:8000",
      "https://user:pass@owned.invalid",
      "https://owned.invalid/api/auth",
      "https://owned.invalid/?target=other",
    ])
      expect(() =>
        readApplicationHttpConfiguration(
          { ...environment, ZCODE_APPLICATION_ACCOUNT_API: target },
          true,
        ),
      ).toThrow();
    expect(
      readApplicationHttpConfiguration(
        {
          ...environment,
          ZCODE_APPLICATION_ACCOUNT_API: "http://localhost:8000",
        },
        false,
      )?.apiOrigin,
    ).toBe("http://localhost:8000");
    expect(() =>
      readApplicationHttpConfiguration(
        {
          ...environment,
          ZCODE_APPLICATION_ACCOUNT_API: "http://private.invalid",
        },
        false,
      ),
    ).toThrow();
  });
  it("requires narrow native API prefixes and keeps instance RPC and platform endpoints closed", () => {
    const narrow = readApplicationHttpConfiguration(
      {
        ...environment,
        ZCODE_APPLICATION_API_PREFIXES: "/api/native/conversations",
      },
      true,
    )!;
    expect(
      applicationHttpTarget(
        narrow,
        "/api/native/conversations/source-admission",
      ).origin,
    ).toBe("https://owned.invalid");
    expect(() => applicationHttpTarget(narrow, "/api/native/rpc")).toThrow();
    for (const prefix of [
      "/api/native",
      "/api/native/rpc",
      "/api/native/rpc-host",
      "/api/platform",
      "/api/platform/settings",
    ])
      expect(() =>
        readApplicationHttpConfiguration(
          { ...environment, ZCODE_APPLICATION_API_PREFIXES: prefix },
          true,
        ),
      ).toThrow();
  });
  it("rejects other origins, prefix lookalikes and normalized/encoded traversal", () => {
    for (const path of [
      "https://other.invalid/api/profile/me",
      "//other.invalid/api/profile/me",
      "/api/profile-other/me",
      "/api/profile/../platform/me",
      "/api/profile/%2e%2e/platform/me",
      "/api/profile/%2Fplatform",
      "/api/native/rpc",
      "/api/profile/me#secret",
      "/api/profile/\\other",
    ])
      expect(() => applicationHttpTarget(configuration, path)).toThrow(
        "application_http_path_rejected",
      );
    expect(
      applicationHttpTarget(
        configuration,
        "/api/profile/me?cursor=owned%20cursor",
      ).origin,
    ).toBe("https://owned.invalid");
  });
  it("uses the current Main CSRF value on each write and never returns Set-Cookie", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce([{ value: "first%20proof" }])
      .mockResolvedValueOnce([{ value: "second-proof" }]);
    const fetch = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("{}", {
          headers: {
            "Set-Cookie": "__Host-owned-session=owned-synthetic",
            "X-Correlation-ID": "owned-correlation",
          },
        }),
    );
    for (let count = 0; count < 2; count++) {
      const result = await performApplicationHttp(
        configuration,
        {
          ...input,
          method: "POST",
          contentType: "application/json",
          body: new TextEncoder().encode("{}").buffer,
        },
        { cookies: { get }, fetch },
        new AbortController().signal,
      );
      expect(
        result.headers.some(([name]) => name.toLowerCase() === "set-cookie"),
      ).toBe(false);
      expect(result.headers).toContainEqual([
        "x-correlation-id",
        "owned-correlation",
      ]);
    }
    expect(get).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0]).toBe(
      "https://owned.invalid/api/profile/me",
    );
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      credentials: "include",
      redirect: "error",
      cache: "no-store",
      headers: {
        Origin: "https://owned.invalid",
        "X-CSRF-Token": "first proof",
      },
    });
    expect(fetch.mock.calls[1]![1]).toMatchObject({
      headers: { "X-CSRF-Token": "second-proof" },
    });
  });
  it("rejects GET bodies before any cookie or network access", async () => {
    const get = vi.fn(),
      fetch = vi.fn();
    const result = await performApplicationHttp(
      configuration,
      { ...input, body: new ArrayBuffer(1) },
      { cookies: { get }, fetch },
      new AbortController().signal,
    );
    expect(result.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
