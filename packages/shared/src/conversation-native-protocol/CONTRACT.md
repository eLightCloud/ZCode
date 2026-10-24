# conversation-native-protocol

既有会话同步/接续/文件的同一 wire schema 与只读搜索投影。此组件没有 IO、接纳队列、lease、正文解释器或授权 writer；只复用原生 Shared 唯一类型和严格校验。session/operation/version/identity 与 opaque checkpoint 边界不变。技术 URI 和 zcode 标识保留，不因品牌替换迁移存量。

本次只明确既有组件、public facade 与数据定义，不重定义执行、授权或时序合同。保留已有低敏日志/错误/关联标识；完整组件、现有调用方与最终组合门按实际结果验证。
