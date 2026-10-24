# CLI 遥测 adapter

owner 为进程级遥测运行时。公开实现入口是现有 `index.ts`，端口和身份结构唯一来源为
`@zcode/contracts/telemetry`，本地 contract 仅承接该类型，不建立第二份执行或计费事实。

- 进程 owner 创建 exporter / provider / context manager，Session 仅借用端口并 abandon 自身 writer；flush 不等于 shutdown。
- 内部 active writer 集合只有运行时 owner 写入，容量限制、父子因果、一次结算和旁路失败诊断保持；内部方法 context 不反向依赖 owner 私有类型。
- 所有外发属性继续使用现有白名单、脱敏、数量 / 长度限制；凭据、完整用户正文与 prompt 不通过合同公开。
- Core / Bootstrap 消费规范端口；OTLP、文件锁和默认设备身份仅由本 adapter 实现，不裁决业务授权或重新执行任务。

模块登记不改变网络默认值或新增环境变量。契约测试验证真实公开脱敏实现，原有完整测试验证 span 生命周期、限流与 exporter 故障。
