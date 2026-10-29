# Native execution protocol

原生 Session、输入、检查点、事件与工作流结构继续由既有 port / schema 定义。本模块纳管 interfaces、events 与 workflow 三组紧密相依的协议；不建立企业执行核心或第二份恢复结构。

- interfaces 与 workflow 的类型、Zod 校验、派生函数属于纯领域 / 数据合同。调用权限仍由实际服务端接纳与执行 owner 决定。
- `events/in-memory-session-event-store.ts` 是 app 层状态实现，独占进程内事件序号及保留窗口；接口 / reducer 不反向依赖此实现。持久化、远端 ACK 与接纳不可因这个内存缓冲替代。
- 文本 / 文件可移植子集、静止检查点及 continuation 语义只复用原定义；不接受本机路径、额外权限、凭据或任意 metadata 扩权。
- 既有 package exports 和 interfaces / workflow 子入口维持原兼容面；跨组件新增依赖只能使用显式公开入口，不因纳管开放任意源码。
- 验证覆盖父 guarded 权限继承、附件路径拒绝及原有事件序号、淘汰、工作流和检查点回归。没有新增调度、迁移、IO 或环境变量；观测与错误传播保持原链路。

Text checkpoint v4 的模型变更 timeline 使用原生 TimelineModelSelection，保留可选显示 label。模型身份与选项继续复用唯一 modelSelectionSchema 严格验证，不能把任意配置、凭据或未知字段混入；显示标签不是目标模型选择或执行授权。
首条真实 user 输入之前可保留原生 system / timeline_event / provider hidden 的已校验维护记录；必须仍存在 user 输入，普通 assistant 回答及父子关系不放宽。
原 commandId 提取由 checkpointOriginalCommandId 单一拥有，只取首次真实 user 输入，不能把前置维护 marker 视为原账号输入；Host 捕获及原生导出复用它。

检查点中的已消费输入可保留原生已知权限模式作为历史事实，但不形成目标端授权；输入仍必须为终态，导入不得重放。可执行的 execution 仍只接受 build / guarded，来源 edit / yolo / auto 在导出时回到 build，Plan 标记保留。目标端不接收完整访问授权回执、源 Shell 选择或本地工作区回滚快照；源数据保持原样，未知必要状态继续拒绝。导入与再次导出必须保持这一安全投影稳定，不因历史输入中的 mode 恢复来源权限。

可移植 assistant error.data 保留原生 Stop 已持久化的可选 `turnResult: "cancelled"`。冷恢复继续据此识别正常取消；仅允许该已知字面值，未知结果、附加字段和权限内容仍严格拒绝。导出、导入及重开不得丢弃这一终态事实。
