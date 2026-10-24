# Native execution protocol

原生 Session、输入、检查点、事件与工作流结构继续由既有 port / schema 定义。本模块纳管 interfaces、events 与 workflow 三组紧密相依的协议；不建立企业执行核心或第二份恢复结构。

- interfaces 与 workflow 的类型、Zod 校验、派生函数属于纯领域 / 数据合同。调用权限仍由实际服务端接纳与执行 owner 决定。
- `events/in-memory-session-event-store.ts` 是 app 层状态实现，独占进程内事件序号及保留窗口；接口 / reducer 不反向依赖此实现。持久化、远端 ACK 与接纳不可因这个内存缓冲替代。
- 文本 / 文件可移植子集、静止检查点及 continuation 语义只复用原定义；不接受本机路径、额外权限、凭据或任意 metadata 扩权。
- 既有 package exports 和 interfaces / workflow 子入口维持原兼容面；跨组件新增依赖只能使用显式公开入口，不因纳管开放任意源码。
- 验证覆盖父 guarded 权限继承、附件路径拒绝及原有事件序号、淘汰、工作流和检查点回归。没有新增调度、迁移、IO 或环境变量；观测与错误传播保持原链路。
