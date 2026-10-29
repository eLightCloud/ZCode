import { describe, expect, it } from "vitest";
import { mapSkillsToMentionItemsForTest } from "../src/mentions/providers/skillsMentionProvider.js";

describe("skills mention provider", () => {
  it("dedupes same-name skills for $ panel and prefers workspace source", () => {
    const items = mapSkillsToMentionItemsForTest([
      {
        id: "claude:user:review:a",
        name: "review",
        description: "user review",
        path: "/home/user/.claude/skills/review/SKILL.md",
        scope: "user",
      },
      {
        id: "claude:plugin:review:b",
        name: "review",
        description: "plugin review",
        path: "/home/user/.claude/plugins/review/skills/review/SKILL.md",
        scope: "plugin",
      },
      {
        id: "claude:workspace:review:c",
        name: "review",
        description: "workspace review",
        path: "/repo/.claude/skills/review/SKILL.md",
        scope: "workspace",
      },
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      label: "review",
      value: "review",
      description: "Workspace · workspace review",
      data: {
        scope: "workspace",
        path: "/repo/.claude/skills/review/SKILL.md",
      },
    });
  });

  it("$ panel displays the original frontmatter skill name without formatting", () => {
    const items = mapSkillsToMentionItemsForTest([
      {
        id: "claude:user:agent-browser:a",
        name: "agent-browser",
        description: "browser",
        path: "/home/user/.claude/skills/agent-browser/SKILL.md",
        scope: "user",
      },
    ]);

    expect(items[0]).toMatchObject({
      label: "agent-browser",
      value: "agent-browser",
      keywords: ["agent-browser", "browser", "user"],
    });
  });

  it("localizes bundled plugin skill descriptions for the $ panel", () => {
    const skill = {
      id: "builtin-pdf",
      name: "pdf",
      description: "专业 PDF 工具集",
      path: "/cache/zcode-plugins-official/document-skills/0.1.0/skills/pdf/SKILL.md",
      scope: "plugin" as const,
      pluginName: "document-skills",
    };

    expect(mapSkillsToMentionItemsForTest([skill], "en-US")[0]?.description).toContain(
      "Plugin · Professional PDF toolkit",
    );
    expect(mapSkillsToMentionItemsForTest([skill], "zh-CN")[0]?.description).toContain(
      "插件 · 专业 PDF 工具集",
    );
  });

  it("localizes the official Browser Use tester skill by plugin name", () => {
    const skill = {
      id: "builtin-web-gui-tester",
      name: "web-gui-tester",
      description: "frontmatter fallback",
      path: "/plugins/browser-use/skills/web-gui-tester/SKILL.md",
      scope: "plugin" as const,
      pluginName: "browser-use",
    };

    expect(mapSkillsToMentionItemsForTest([skill], "en-US")[0]?.description).toContain(
      "Plugin · Run pure GUI black-box tests",
    );
    expect(mapSkillsToMentionItemsForTest([skill], "zh-CN")[0]?.description).toContain(
      "插件 · 使用 ZCode Browser Use 对网页和本地 Web 前端执行纯 GUI 黑盒测试",
    );
  });

  it("brands curated builtin descriptions without rewriting user content or historical sources", () => {
    const skills = [
      {
        id: "builtin-browser",
        name: "control-browser",
        description: "original source description",
        path: "/plugins/browser-use-plugin/skills/control-browser/SKILL.md",
        scope: "plugin" as const,
        pluginName: "browser-use",
      },
      {
        id: "custom",
        name: "custom",
        description: "Read ZCode documentation using ${ZCODE_PLUGIN_ROOT}",
        path: "/repo/.zcode/skills/custom/SKILL.md",
        scope: "workspace" as const,
      },
      {
        id: "restore",
        name: "restore-legacy-sessions",
        description: "restore source description",
        path: "/plugins/restore-legacy-sessions-plugin/skills/restore-legacy-sessions/SKILL.md",
        scope: "plugin" as const,
        pluginName: "restore-legacy-sessions",
      },
    ];
    const original = structuredClone(skills);
    const items = mapSkillsToMentionItemsForTest(skills, "zh-CN", "翼辉睿观");

    expect(items[0]?.description).toContain("控制 翼辉睿观 内置浏览器");
    expect(items[1]?.description).toBe(`工作区 · ${skills[1]!.description}`);
    expect(items[2]?.description).toContain("ACP 时代 ZCode 旧 session");
    expect(skills).toEqual(original);
  });
});

it.each(["zh-CN", "en-US"] as const)(
  "brands all six builtin guide suggestions in %s without changing execution references",
  (locale) => {
    const names = [
      "diagnosing-commands",
      "diagnosing-hooks",
      "diagnosing-mcp",
      "diagnosing-plugins",
      "diagnosing-skills",
      "zcode-configuration-guide",
    ];
    const skills = names.map((name) => ({
      id: name,
      name,
      description: "Use ZCode configuration",
      scope: "plugin" as const,
      path: `/cache/zcode-plugins-official/zcode-guide/0.3.0/skills/${name}/SKILL.md`,
      pluginName: "zcode-guide",
      pluginId: "zcode-guide@zcode-plugins-official",
    }));
    const brand = locale === "zh-CN" ? "翼辉睿观" : "eLight Vantage";
    const items = mapSkillsToMentionItemsForTest(skills, locale, brand);
    for (const [i, item] of items.entries()) {
      expect(item.label).not.toMatch(/zcode/i);
      expect(item.description).toContain(brand);
      expect(item.description).not.toMatch(/zcode/i);
      expect(item.value).toBe(names[i]);
      expect(item.markdown).toContain(skills[i]!.path);
    }
    const personal = {
      ...skills[5]!,
      pluginId: "zcode-guide@personal",
      path: "/personal/SKILL.md",
    };
    expect(mapSkillsToMentionItemsForTest([personal], locale, brand)[0]).toMatchObject({
      label: personal.name,
      description: expect.stringContaining(personal.description),
    });
  },
);
