# Native I/O adapter assembly

此组件是既有 `@zcode/adapters` 包的物理 IO 边界与公开工厂装配，依赖 contracts、shared、provider 等底层合同，不导入 Core 或 Bootstrap。不把 Core / Bootstrap 执行编排归到 adapters。

- package.json 已声明的 exports 是唯一公开工厂 / 子入口；contract 只承接既有原生 port，不复制 Session、Plugin 或 Model 结构。
- 文件、SQLite、进程、HTTP、模型与 MCP 的实际 IO 由相应现有适配实现执行；执行接纳、业务授权、输入队列和恢复决策不在本装配建立第二 owner。
- 插件身份、固定 Git / ZIP 来源、安装事务、停用选择及配置继续沿原安装 writer；同步的正文、outbox 与 Host 管理事实沿各自原 owner。
- checks 是本包合成验证入口，不是产品的第二执行路径；只使用本轮受控目录 / 数据库。测试配置同时收集既有用例与 managed contract。
- 新准入会继续暴露并修复循环、深导入和超限；不会扩大 baseline、上游准入或例外，已登记的更小逻辑组件边界继续保留。

本次登记保持原错误、取消、重试与低敏观察，不新增环境变量或企业授权语义。

文本检查点由既有 session-store export / import writer 投影：已知 runtime/bash_shell_selection、runtime/permission_full_access、runtime/workspace_checkpoint 只属于源执行环境 / 授权 / 本地回滚，不进入可移植检查点，也不删除源记录。来源权限经 contracts 的原生枚举校验，execution 仅投影 build / guarded；已消费输入的原模式保留为历史事实。导出记录有界的本地记录排除计数及权限重置结果，不输出内容、Shell 路径或权限回执。未知 entry、活跃工具、未消费输入及必要文件缺失仍拒绝。
已完成工具的空 part metadata 作为缺省投影；state.metadata 中仅源文件有效的 readFileState 不进入目标，以免恢复未经目标重读的编辑前置缓存。工具输入、输出、附件及其它已声明元数据仍由既有严格 codec 校验，非空未知 metadata 不丢弃。
SessionStore 的既有 continuation stage 元数据可持久化可信原位保留标记；apply 在原屏障内核验当前导出与 staged 检查点相同后保留原记录，变更或缺失即拒绝。跨位置恢复仍正常导入并清除历史授权；原位标记的接纳条件只以 conversation-sync/CONTRACT.md 为准，不新增存储或恢复 owner。

应用托管模型的私有身份只装配到可信启动指定的固定传输地址；目录中的公共展示地址不决定凭据目的地。账号范围 Header 与调用来源沿捕获的 Provider 快照保留，缺失身份或非法启动地址在传输前拒绝；个人 Provider 不消费此私有身份。
