# cli-tool-runtime

原生工具注册、调度、执行/结算与 MCP 工具投影。原执行器、背景跟踪器与 registry 是唯一 owner；新 context 不复制 poller、队列或结果。Runtime 通过具名 host 能力面使用模型曝光、工作流 authoring 和结果显示；handler 私有实现不作 wildcard public。Channel reply / workflow tool entrypoints 的细分模块继续保留。模型上下文包装由原 model protocol 组件唯一实现；schema、审批、取消、日志、artifact/Delivery 分离和持久化均不改变。

- 既有稳定 source 入口按能力显式登记；公开构造/合同与具名集成面可消费，未登记的 handler / state / context 仍为内部实现。
- app 保留通过端口的业务编排；实际文件/进程/环境/定时器及其接线按路径登记 adapters，不改变原生执行所有权。
- 迁移 SQL、checksum、存量会话、插件身份和授权不因本次治理改写。保留 trace / session / turn / toolCallId 和原有拒绝/失败事件。
- 合同测试必须验证真实行为/失败边界，并复验整个 Core 与 Bootstrap 调用方；不以 module.id 或文档存在替代执行验证。
