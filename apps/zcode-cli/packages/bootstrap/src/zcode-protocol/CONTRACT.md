# Native protocol host

本模块是既有 ZCode Protocol / V4 的接入与投影适配，不是第二执行器。Core Runtime 仍独占执行接纳、权限、Turn、取消和历史结算；Host 继续独占实例及恢复证明。协议只保持连接、请求相关标识、派生投影及回放 / live 通道。

- server.ts、transport.ts、V4 index / replay 和 contract.ts 承接既有公开入口，不按源码目录开放所有文件。MCP Apps 仍保留独立凭证 / sampling owner，只消费收窄的协议集成合同。
- server-operations 的公开方法名与调用方式保留，内部按会话记录装配、创建 / 恢复 / fork、查询、输入 / goal 控制、快照、历史导入和通知归属；不按固定行数切片。
- 原事件序号继续写在同一 session record；事件 codec / replay / live 共用原映射与合批算法。live 弱引用合批状态只在 live 模块保留一份，replay 只使用一次调用的栈内工作集，不复制接纳队列。
- Server / Gateway / Publisher / Projection 的内部状态形状不从 owner 类反向取型；方法仍借用同一 owner，没有另一份 cache、listener、lease、receipt 或 ACK。
- continuous 与 replayable 的时间、屏障、缺口修复和未知 ACK 仍按既有合同；会话同步的正文 / outbox / PoP 不在本模块重新裁决。
- 对外错误代码、stdout 帧与 stderr 日志、低敏字段、trace / request / session 关联、取消和 deadline 都保留。治理不改 migration、历史 checksum、技术身份、插件权利或存量数据。

测试继续覆盖原 bootstrap 的真实协议 / 生命周期 / 同步 / 工具用例，并收集本模块合同测试；不得只证明 module.id 或减少原断言。
