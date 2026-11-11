# Native CLI terminal UI

本组件拥有终端渲染、键盘 / 选区交互及 renderer 生命周期，公开 facade 仍为 `@zcode/tui` 的 `runTui` 与 `TuiOptions`，不新增业务接口或执行状态。`contract.ts` 仅引用现有入口。

- 进程入口先校验可信应用名与 locale，TUI 从 options 读取，不读取品牌 env 或企业 manifest。
- 首帧先展示 cwd、启动提示与取消方式，后调用 `loadStartupOptions`；等待期间 Ctrl+C 返回 130，非交互终端返回 1 且不启动 Agent。主题探测不阻塞首次绘制。
- 会话、授权、配置、模型执行与持久化归 Bootstrap / Core；TUI 通过已注入的回调查询、提交和订阅，不成为第二 owner。
- `applicationName` 仅格式化产品展示，不修改真实路径、命令、协议及历史内容；缺省原生名由 i18n 保持。失败向 CLI 入口传播，renderer 的退出与资源回收沿原有行为。
- 首屏与延迟加载的实际 renderer 回归位于 CLI `tests/tui-startup.test.ts`；`contract.test.ts` 验证公开非交互边界。
