import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import { getAppConfigDir } from "@zcode/services/node";

export type ElectronAppPathName = "appData" | "userData";

export function isElectronAppPackaged(): boolean {
  return (app as unknown as { isPackaged?: boolean } | undefined)?.isPackaged === true;
}

export function getElectronAppPath(name: ElectronAppPathName): string {
  const electronApp = app as unknown as
    | { getPath?: (pathName: ElectronAppPathName) => string }
    | undefined;
  if (electronApp?.getPath) {
    return electronApp.getPath(name);
  }

  // 部分 main-process 单测只 mock 被测模块直接需要的 Electron API，
  // 间接导入 desktopRuntimeEnv 时可能拿不到 app。真实桌面运行仍走 app.getPath；
  // Node-only 测试用配置目录兜底，避免导入期常量把无关测试打断。
  return getAppConfigDir();
}

export function getPackagedElectronAppName(): string | undefined {
  return app?.isPackaged ? app.getName?.() : undefined;
}

export async function getDesktopApplicationBrand(): Promise<
  { name: string; id: string; attribution?: string } | undefined
> {
  if (!app?.isPackaged) {
    if (!process.env.ZCODE_APPLICATION_NAME) return undefined;
    if (!process.env.ZCODE_APPLICATION_ID) throw new Error("application-brand.missing-id");
    return {
      name: process.env.ZCODE_APPLICATION_NAME,
      id: process.env.ZCODE_APPLICATION_ID + ".dev",
      attribution: process.env.ZCODE_APPLICATION_ATTRIBUTION,
    };
  }
  const metadata = JSON.parse(await readFile(join(app.getAppPath(), "package.json"), "utf8"));
  const brand = metadata.applicationBrand;
  if (!brand) return undefined;
  if (typeof brand.name !== "string" || typeof brand.id !== "string") {
    throw new Error("application-brand.invalid-package-identity");
  }
  return brand;
}
