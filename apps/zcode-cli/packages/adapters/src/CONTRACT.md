# Native I/O adapter assembly

此组件是既有 `@zcode/adapters` 包的物理 IO 边界与公开工厂装配，依赖 contracts、shared、provider 等底层合同，不导入 Core 或 Bootstrap。不把 Core / Bootstrap 执行编排归到 adapters。

- package.json 已声明的 exports 是唯一公开工厂 / 子入口；contract 只承接既有原生 port，不复制 Session、Plugin 或 Model 结构。
- 文件、SQLite、进程、HTTP、模型与 MCP 的实际 IO 由相应现有适配实现执行；执行接纳、业务授权、输入队列和恢复决策不在本装配建立第二 owner。
- 插件身份、固定 Git / ZIP 来源、安装事务、停用选择及配置继续沿原安装 writer；同步的正文、outbox 与 Host 管理事实沿各自原 owner。
- checks 是本包合成验证入口，不是产品的第二执行路径；只使用本轮受控目录 / 数据库。测试配置同时收集既有用例与 managed contract。
- 新准入会继续暴露并修复循环、深导入和超限；不会扩大 baseline、上游准入或例外，已登记的更小逻辑组件边界继续保留。

本次登记保持原错误、取消、重试与低敏观察，不新增环境变量或企业授权语义。
