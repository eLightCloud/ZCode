import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/** Public build hook: a trusted application supplies static display metadata and assets. */
export async function applicationBrandPlugin(env) {
  const manifestFile = env.ZCODE_APPLICATION_BRAND_MANIFEST;
  if (!manifestFile) return null;
  if (!isAbsolute(manifestFile)) throw new Error("application-brand.absolute-manifest-required");
  const correlationId = randomUUID();
  let metadata;
  let source;
  const assets = new Map();
  const types = {
    svg: "image/svg+xml",
    ico: "image/x-icon",
    png: "image/png",
    webmanifest: "application/manifest+json",
  };
  try {
    metadata = JSON.parse(await readFile(manifestFile, "utf8"));
    if (
      metadata.schemaVersion !== 1 ||
      typeof metadata.applicationName !== "string" ||
      !metadata.applicationName.trim()
    ) {
      throw new Error("application-brand.invalid-manifest");
    }
    source = await readFile(join(dirname(manifestFile), "source.svg"), "utf8");
    const names = [
      "mark-black.svg",
      "mark-white.svg",
      "favicon.svg",
      "favicon.ico",
      "apple-touch-icon.png",
      "app-icon-192.png",
      "app-icon-512.png",
      "maskable-512.png",
      "site.webmanifest",
    ];
    await Promise.all(
      names.map(async (name) =>
        assets.set(name, await readFile(join(dirname(manifestFile), "assets", name))),
      ),
    );
  } catch {
    throw new Error("application-brand.configuration-unavailable");
  }
  let base = "/";
  const escape = (value) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
  return {
    name: "application-brand",
    enforce: "pre",
    resolveId(id) {
      // 编辑器装饰与历史消息图标不消费 React Context；在既有品牌构建入口替换同一产品帮助资源。
      const guideAsset = fileURLToPath(
        new URL("../packages/ui/src/assets/plugin-icons/zcode-guide.png", import.meta.url),
      );
      if (id === "@/assets/plugin-icons/zcode-guide.png" || id === guideAsset) {
        return join(dirname(manifestFile), "assets", "app-icon-192.png");
      }
      return null;
    },
    config() {
      const id = metadata.builtinMarketplaceId ?? "zcode-plugins-official";
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))
        throw new Error("application-brand.invalid-marketplace");
      return { define: { __ZCODE_APPLICATION_PLUGIN_MARKETPLACE_ID__: JSON.stringify(id) } };
    },
    configResolved(config) {
      base = config.base;
    },
    configureServer(server) {
      server.config.server.fs.allow.push(dirname(manifestFile));
      server.middlewares.use((req, res, next) => {
        const prefix = "/application-brand/";
        const url = (req.url || "").split("?")[0];
        if (!url.startsWith(prefix)) return next();
        const name = url.slice(prefix.length);
        const content = assets.get(name);
        if (!content) {
          res.statusCode = 404;
          res.end();
          return;
        }
        res.setHeader("Content-Type", types[name.split(".").at(-1)]);
        res.setHeader("Cache-Control", "no-cache");
        res.end(content);
      });
    },
    transformIndexHtml(html) {
      html = html.replace(
        /<title>.*?<\/title>/s,
        `<title>${escape(metadata.applicationName)}</title>`,
      );
      html = html.replace(/<link\b[^>]*rel=["'](?:icon|apple-touch-icon|manifest)["'][^>]*>/g, "");
      const geometry = /<path\b[^>]*\/>/s.exec(source)?.[0];
      if (!geometry) throw new Error("application-brand.invalid-mark");
      html = html.replace(
        /<svg\b([^>]*class=["'](?:startup-logo|zcode-boot-loading__logo)["'][^>]*)>[\s\S]*?<\/svg>/g,
        (_, attrs) =>
          `<svg ${attrs
            .replace(/viewBox=["'][^"']+["']/, 'viewBox="0 0 256 256"')
            .replace(/width=["'][^"']+["']/, 'width="256"')
            .replace(/height=["'][^"']+["']/, 'height="256"')}>${geometry}</svg>`,
      );
      return {
        html,
        tags: [
          {
            tag: "meta",
            attrs: { name: "application-name", content: metadata.applicationName },
            injectTo: "head",
          },
          {
            tag: "link",
            attrs: {
              rel: "icon",
              type: "image/svg+xml",
              href: `${base}application-brand/favicon.svg`,
            },
            injectTo: "head",
          },
          {
            tag: "link",
            attrs: {
              rel: "apple-touch-icon",
              href: `${base}application-brand/apple-touch-icon.png`,
            },
            injectTo: "head",
          },
          {
            tag: "link",
            attrs: { rel: "manifest", href: `${base}application-brand/site.webmanifest` },
            injectTo: "head",
          },
        ],
      };
    },
    generateBundle() {
      for (const [name, content] of assets)
        this.emitFile({ type: "asset", fileName: `application-brand/${name}`, source: content });
      console.info(
        JSON.stringify({
          event: "application.brand.bundle",
          component: "application-build",
          correlation_id: correlationId,
          outcome: "succeeded",
          asset_count: assets.size,
        }),
      );
    },
  };
}
