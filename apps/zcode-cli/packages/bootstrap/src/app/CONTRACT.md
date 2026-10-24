# Native app assembly

本模块装配原生端口与应用 facade，不是企业执行器。Core Runtime 保持接纳、Turn、权限、取消、恢复和持久化事实的唯一 owner。

- 配置、工厂、运行资源和端口的生命周期由本装配拥有。直接访问文件、进程、环境或时钟及将它们接起来的入口为 adapters；只通过已经注入的端口编排的功能保持 app。附件字节解码是无 IO 的 domain。策略精确登记文件，不把整个 CLI 提升为 adapters。
- contract.ts 声明构造与资源操作合同；既有 create-app / paths / provider / query 等窄入口按职责显式登记 publicEntrypoints。保持调用者原有导入粒度，避免聚合 barrel 导致纯查询加载整份 Provider / App。内部类型定义不反向导入总 facade。子代理读模型属于应用，而不依赖 wire host。旧 query 入口保留查询转出，算法只有一份。
- 首次用户执行、恢复屏障、Shell/模型选择、trace 传播、workspace identity、关闭顺序均按现有原生合同。只有原 controller 保存审核 flow/generation/mutationQueue，不新增队列、重试或配置 fallback。
- 自有 Git 插件、配置路径与未知存量不会在治理中重置；migrations 和 checksum 不修改。已有结构化启动、权限、存储、错误及关闭日志保留。

回归使用已有完整 Bootstrap 套件及真实附件边界合同测试。
