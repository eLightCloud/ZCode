# 应用侧栏主区页面导航合同

可信装配通过 `ApplicationPage.sidebarOrder` 把业务页面注册为侧栏挂载、主区呈现的导航目标。原生壳拥有稳定页面 ID、导航状态、选中态、打开 / 返回与生命周期；装配只提供标签、图标、顺序意图和 render。没有 `sidebarOrder` 的页面默认走工具栏 + 全屏 Dialog；可显式设置 `presentation: "dialog"`，复用 `ApplicationDialog` 的居中浮层、关闭、Escape 与焦点返回，内容标题、刷新和分区由装配提供，不叠加全屏导航工具栏。普通 ZCode 无装配时导航完全保持原状。

## 状态与事件

- `ApplicationPageNavigationProvider`（Root 层）是选中页的唯一 owner：`selectedPageId`、`generation`、打开来源焦点。打开 / 关闭 / 刷新分别记录 `application.page.opened` / `closed` / `refreshed`（沿用既有 pageId 事件名）。
- `sidebarPages` 按 `sidebarOrder` 升序、同值按注册顺序稳定排序；`dialogPages` 为其余页面。侧栏页面不出现在 Dialog 导航行，也不作为工具栏 `first` 兜底；`headerPageId` 仍可指向任意页面（如 standalone 通知）。
- 页面内部导航沿用 `useApplicationPageNavigation()`；跨层打开（深链、文件卡、通知）经 `Root.applicationPageIntent`（`{ pageId, token }`，一次性消费回调 `onApplicationPageIntentConsumed`）。

## 主区呈现与返回

- WorkspaceShellLayout 在选中侧栏页面时把主区切换为该页面（`ApplicationPageContent` + 错误边界 + 面包屑框架），侧栏、选中态和会话草稿保持挂载；`workspaceMainView` 不变，关闭页面回到原主视图。
- 打开侧栏页面时把底层主视图归位为聊天页；打开自动化 / 场景先关闭侧栏页面，保证两个入口互斥、返回语义唯一。主返回按钮在页面打开时等于关闭页面并恢复焦点到触发按钮。
- 手机远控 shell 不承载侧栏页面；远控挂载时立即关闭并回聊天页。
- 普通手机 Web 的侧栏主区页在窄屏收起侧栏与分隔条，保留主区返回按钮；返回恢复原导航。无项目 / RPC 离线的工作区提示不覆盖已选中的应用页。
- 页面注册失效只由导航 Provider 裁决，Dialog surface 不得把侧栏页判为失效。打开意图消费后由装配保持独立递增 token；侧栏和意图打开都归位底层聊天视图。

## 侧栏入口

- `ProjectSidebarProps` 新增 `applicationSidebarPages`、`activeApplicationPageId`、`onOpenApplicationPage`。按钮渲染在场景入口之后，保持确定性顺序；不依赖项目连接（`disabled` 不适用），无装配时该区域不渲染。
- 页面内容禁止访问执行连接之外的原生私有状态；平台差异由公开平台接口注入。

## 公开视觉资源

共享 UI 包的公开入口可重导出自身已经使用的 Lucide 图标（Archive、Cloud、RefreshCw、Info、SearchX、AlertCircle、ChevronLeft / Right、Search、SlidersHorizontal、List、LayoutGrid、X、Download、Eye、Ellipsis、Link）。应用侧栏图标和可信页面的文件列表 / 工具栏使用同一图标库；装配不得穿透原生私有组件或 node_modules。图标只表达视觉语义，不拥有业务状态、权限或额外日志。

文件类型图标继续由既有 `resolveFileDisplayDescriptor` / `FileDisplayIcon` 拥有扩展名映射、素材路径及失效替代，`FileDisplayIcon` 与既有描述符一同从 UI 包公开，不在装配内另写文件类型解析器。
