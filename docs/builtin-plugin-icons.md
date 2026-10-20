# 内置插件图标

内置插件的商店信息定义在 `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`，UI 图标解析统一由 `packages/ui/src/lib/pluginIconSource.ts` 拥有。

## 原图与产品品牌边界

插件图标、示例文档图标、推荐图标及插件详情内容图片保留其真实身份，不能使用 `ApplicationBrandImage` 替换为发行产品标志。该品牌组件只用于产品自身的标题栏、侧栏品牌和其他产品标识。

客户端优先消费 `packages/ui/src/assets/plugin-icons/` 的固定打包原图。解析使用受信构建的 `BUNDLED_PLUGIN_MARKETPLACE_ID`，并识别上游原始身份；不能按插件裸名称覆盖任意个人市场图标。已知官方图标 URL 也映射到相同本地字节，推荐项没有 pluginId 时仍可使用原图。个人插件其他 HTTPS 图标继续沿原受信图片规则显示，不新增任意本地地址白名单或后台 URL 代理。

| 图标集合 | 本地文件 |
| --- | --- |
| 已有独立图标 | documents、pdf、presentations、spreadsheets、image-search、plugin-creator |
| 保存的上游原图 | android-emulator、browser-use、document-skills、ios-simulator、restore-legacy-sessions、skill-creator、zcode-guide、computer-use |

新增保存原图的来源、SHA-256 与字节数见同目录 `sources.json`，原图未经重绘，随 Desktop / Web 静态构建交付，运行时不请求这些图标的官方 CDN。产品分发身份不改变原作者、来源、版权或许可证。

原图的上游来源格式为：

```
https://cdn-zcode.z.ai/zcode/official-plugin/assets/<plugin-name>/icon.png
```

`computer-use` 复用已发布的 `assets/zcode-cua/icon.png`。插件标识从 `zcode-cua`
改为 `computer-use` 后，CDN 资源目录仍保留原名；不能随插件标识拼接出尚未发布的
`computer-use/icon.png`（会返回 404）。图标路径与插件标识可以独立维护。

资源文件由 `zcode-plugins` 仓库的 `assets/<plugin-name>/icon.png` 提供；该仓库的
`main` 分支发布流水线会将 assets 目录同步到 CDN。目录中的远端图标使用 HTTPS URL；客户端固定打包资源也由同一个图标解析器校验。PNG 必须使用透明背景，并保留 Figma 原始颜色；商店使用语义化
`bg-hover` 容器承载图标，不再对整张图片做深色主题反相，避免 Android、iOS、ZCode
等品牌色在深色主题失真。Installed Strip 也不得根据插件启用状态对头像整体应用透明度；
启用状态由管理视图表达。若资源请求失败或没有配置图标，插件商店会继续显示默认图标。

Figma 节点 `5080:5352` 的 Installed Strip 定义了内置图标的视觉契约：36px 圆角容器
内居中放置 24px 图形。内置插件定义顺序与图标顺序必须保持一致：

1. `android-emulator` → `android`
2. `document-skills` → `dotpoints-01`
3. `ios-simulator` → `ios`
4. `restore-legacy-sessions` → `Frame`（归档盒上箭头）
5. `skill-creator` → `Frame`（立方体）
6. `zcode-guide` → ZCode 标志

Installed Strip 排序时，内置/inline 插件必须整体排在市场安装插件之前，并按当前语言
下的展示名称稳定排序；其余市场安装插件继续按安装时间倒序。排序依据使用运行时
`source`，不以是否缺失 `installedAt` 间接判断内置身份。

当前内置插件集合以 `official-plugin-definitions.ts` 为准，不以历史 Figma 的顺序清单代替运行集合。没有原图或加载失败时仍使用中性 Blocks 占位；图标源改变后重试新源，不沿用旧图片的失败状态。
