import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { createServer } from "vite";

it("reloads the document for renderer bootstrap updates while preserving component Fast Refresh", async () => {
  const desktopRoot = resolve(import.meta.dirname, "..");
  const server = await createServer({
    configFile: resolve(desktopRoot, "vite.config.ts"),
    root: resolve(desktopRoot, "src/renderer"),
    logLevel: "silent",
    server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const entry = await server.transformRequest("/src/main.tsx");
    expect(entry?.code).toContain("createRoot(");
    // Side-effectful entry must reach the document reload boundary, never re-evaluate in place.
    expect(entry?.code).not.toContain("import.meta.hot.accept(");
    const component = await server.transformRequest(
      "/@fs/" + resolve(desktopRoot, "../ui/src/root/RootStartupLoading.tsx"),
    );
    expect(component?.code).toContain("import.meta.hot.accept(");
    const send = vi.spyOn(server.environments.client.hot, "send");
    const module = await server.environments.client.moduleGraph.getModuleByUrl("/src/main.tsx");
    expect(module).toBeTruthy();
    for (let update = 0; update < 2; update++) {
      send.mockClear();
      await server.environments.client.reloadModule(module!);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "full-reload" }));
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "update" }));
    }
  } finally {
    await server.close();
  }
});
