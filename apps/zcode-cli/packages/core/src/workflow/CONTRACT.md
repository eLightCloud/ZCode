# cli-workflow

原生工作流图与生命周期编排，运行事实仍由原 Runtime / Workflow owner 持有；本次只明确既有 component/public surface。不在企业端复制调度、接受队列或补建恢复状态。取消、恢复、事件与 journal 语义保持。

- 既有稳定 source 入口按能力显式登记；公开构造/合同与具名集成面可消费，未登记的 handler / state / context 仍为内部实现。
- app 保留通过端口的业务编排；实际文件/进程/环境/定时器及其接线按路径登记 adapters，不改变原生执行所有权。
- 迁移 SQL、checksum、存量会话、插件身份和授权不因本次治理改写。保留 trace / session / turn / toolCallId 和原有拒绝/失败事件。
- 合同测试必须验证真实行为/失败边界，并复验整个 Core 与 Bootstrap 调用方；不以 module.id 或文档存在替代执行验证。
