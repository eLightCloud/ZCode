# maintenance-contract

本地原生维护与 daemon 交接，沿既有 operation、Core 持久接纳屏障、process manager hold 与 kernel file lock。Core / supervisor / manager 保持原 owner；未知结果保持 blocked，不以超时假定 idle，不强杀活跃会话。Shared 仅声明严格 wire 数据，local constructor capability 不进入远程 AgentService 接口。更新、读回 identity 与回退沿已有手工发行入口，本次不触发部署、不修改默认数据，不以单测冒充三版本真实 daemon 验收。

本次只明确既有组件、public facade 与数据定义，不重定义执行、授权或时序合同。保留已有低敏日志/错误/关联标识；完整组件、现有调用方与最终组合门按实际结果验证。
