# 原生接续 Host 接合

这是既有 `createConversationRuntimeHost` 及其当前模型投影的同一职责边界，
通过 index 导出。移动目录不增加 Host，也不变更公开 RPC 或恢复格式。

- Core 维护持久接纳屏障与正文，TaskIndexRepo 维护索引和管理动作屏障。
  本模块仅接合二者，内存 tails 只串行本次变更调用，不保存另一份工作队列。
- 先关闭索引动作，再收口 Core；确认正文、原输入与索引后才激活。
  激活中的 owner 复核可直接读取 Core，不能等待自己占用的变更链。
- 模型只经原生模型 facade 投影准确选择与显示名，秘密和配置不离开 owner。
  没有模型能力就保持缺失；目标实际能力仍在 staging / activation 重验。
- 可信外部装配获得相同 private port，浏览器不能指定端口或上报关闭证明。
  Desktop continuous、Web replayable 与账号资格仍沿原 Core / Identity。

未知 ACK 重查原意图，取消遵循原生授予边界；本模块不根据超时重授予，
不修改历史模型事实、provider 配置或其它会话。真实双向交接与恢复另由
隔离 Core / Host / Nginx / Web 纵切证明。

同一 Host 接合同时覆盖既有 createConversationSyncHost 的捕获/索引恢复 façade；只有 TaskIndexRepo 和 Core 原 writer 写入，仍没有新增 Host 或接纳队列。该源路径纳管不改实现。

同步捕获、接续 control / content 与索引屏障经现有 TaskIndexRepo.listConversationSyncTargets 的同一 resolveConversationSyncTarget 解析准确 session 目录。原生 Agent 服务由可信装配注入该解析器，不接受浏览器自报目录；多目录同 ID 明确拒绝，解析失败不得退回 default。仅无索引的首次导入沿原默认命名空间，Core 继续核对实际持库目录、workspaceID 与 taskType，未知存量不因 fallback 改绑。目录映射不缓存、不迁移文件、不改变会话 ID，也不新建持久化 owner。既有控制请求日志继续关联 session / operation / action，目录路由不输出路径或正文。
索引恢复接受已由原生登记用途的准确独立 draft，仍要求原操作屏障，并拒绝目录项目、identity 别名和附加执行目录；不能仅凭目录名扩大资格。
