import documentsIconUrl from "@/assets/plugin-icons/documents.png";
import imageSearchIconUrl from "@/assets/plugin-icons/image-search.png";
import pdfIconUrl from "@/assets/plugin-icons/pdf.png";
import pluginCreatorIconUrl from "@/assets/plugin-icons/plugin-creator.png";
import presentationsIconUrl from "@/assets/plugin-icons/presentations.png";
import spreadsheetsIconUrl from "@/assets/plugin-icons/spreadsheets.png";
import androidIconUrl from "@/assets/plugin-icons/android-emulator.png";
import browserIconUrl from "@/assets/plugin-icons/browser-use.png";
import computerIconUrl from "@/assets/plugin-icons/computer-use.png";
import documentSkillsIconUrl from "@/assets/plugin-icons/document-skills.png";
import iosIconUrl from "@/assets/plugin-icons/ios-simulator.png";
import restoreIconUrl from "@/assets/plugin-icons/restore-legacy-sessions.png";
import skillCreatorIconUrl from "@/assets/plugin-icons/skill-creator.png";
import guideIconUrl from "@/assets/plugin-icons/zcode-guide.png";
import { BUNDLED_PLUGIN_MARKETPLACE_ID } from "@zcode/shared";
import { isTrustedImageUrl } from "@/lib/trustedImageUrl.js";

const BUNDLED_PLUGIN_ICON_BY_NAME: Readonly<Record<string, string>> = {
  documents: documentsIconUrl,
  "image-search": imageSearchIconUrl,
  pdf: pdfIconUrl,
  "plugin-creator": pluginCreatorIconUrl,
  presentations: presentationsIconUrl,
  spreadsheets: spreadsheetsIconUrl,
  "android-emulator": androidIconUrl,
  "browser-use": browserIconUrl,
  "computer-use": computerIconUrl,
  "document-skills": documentSkillsIconUrl,
  "ios-simulator": iosIconUrl,
  "restore-legacy-sessions": restoreIconUrl,
  "skill-creator": skillCreatorIconUrl,
  "zcode-guide": guideIconUrl,
};

const TRUSTED_BUNDLED_PLUGIN_ICONS = new Set(Object.values(BUNDLED_PLUGIN_ICON_BY_NAME));
// 只映射已核验并随包交付的原图，不放宽任意本地 URL，也不在运行时下载官方 CDN。
const LOCAL_ICON_BY_PUBLISHED_URL = new Map(
  Object.entries(BUNDLED_PLUGIN_ICON_BY_NAME).map(([name, localUrl]) => [
    `https://cdn-zcode.z.ai/zcode/official-plugin/assets/${name === "computer-use" ? "zcode-cua" : name}/icon.png`,
    localUrl,
  ]),
);

/** 按完整身份解析客户端自有图标，避免商店、候选和消息各自维护不同例外。 */
export function resolvePluginIconSource(
  pluginId: string | undefined,
  icon?: string,
): string | undefined {
  if (pluginId) {
    const separator = pluginId.lastIndexOf("@");
    const marketplace = pluginId.slice(separator + 1);
    if (marketplace === BUNDLED_PLUGIN_MARKETPLACE_ID || marketplace === "zcode-plugins-official") {
      const bundledIcon = BUNDLED_PLUGIN_ICON_BY_NAME[pluginId.slice(0, separator)];
      if (bundledIcon) return bundledIcon;
    }
  }
  const localIcon = icon ? LOCAL_ICON_BY_PUBLISHED_URL.get(icon) : undefined;
  if (localIcon) return localIcon;
  return isTrustedPluginIconSource(icon) ? icon : undefined;
}

/** Session 投影已完成身份匹配；仅放行固定打包资源，不放宽任意本地 URL。 */
export function isTrustedPluginIconSource(icon: string | undefined): icon is string {
  return Boolean(icon && TRUSTED_BUNDLED_PLUGIN_ICONS.has(icon)) || isTrustedImageUrl(icon);
}
