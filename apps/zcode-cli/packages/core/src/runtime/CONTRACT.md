# Native runtime execution owner

Runtime 是既有原生 Session / Turn 的唯一执行 owner。公开面沿 `core/src/runtime.ts`，企业能力不得建立第二 Runtime。内部实现继续通过唯一内部合同协作，不从实现模块或私有类反向取型。

- 原命令队列、start reservation、foreground lease、branch generation、history 和事件结算仍各只有 Runtime 中的一份状态；不在协议、会话同步或 UI 新增 accepted queue。
- 工具结算方法本来就写本 Runtime 的两份历史并持久化 / 生成恢复锚点。原先单独登记的结算模块只包住这个 this 方法及其类型入口，没有独立状态 owner；现归入 Runtime 同一受管边界，其原方法、合同、示例与回归全部保留，避免把整份私有 this 开放为外部 public facade。
- 子 Runtime 仍由同一个 AgentRuntime 实现构造；子代理编排通过 owner 的内部构造入口取得既有公开 API，不反向导入安装它的 owner 类。父权限、模型、MCP 借用、取消、watchdog 与残留工作结算不改。
- 子代理资源接合（MCP、Skill、CUA）与子会话执行生命周期按职责分离，不创建第二授权器或缓存。
- 文件 / 进程 / 模型等执行沿原 port，存量 shell snapshot 可用性探测及异步上下文仍保留原实现；不为治理修改迁移、恢复身份、超时、低敏日志或输入接纳顺序。
- 所有失败与取消回归继续通过隔离 HOME 的正式 CLI test 运行。纳管暴露的环、深导入、超限与禁用注释必须逐项修复，不扩大豁免 / baseline。
