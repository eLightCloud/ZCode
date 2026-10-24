# conversation-index-persistence

这是 TaskIndexRepo 既有事实读取/动作屏障与版本化迁移辅助的接合。TaskIndexRepo 与现有 tasksDatabase ledger 仍是索引/迁移唯一 writer；此登记不新增迁移入口，不修改 SQL、历史 checksum、workspace 分类或未知旧行。原 data_version/total_changes 一致性保护、持久屏障、保留 pinned/title/archived/deleted 与 source qualification 不变。SQL 常量只供原版本化 ledger/隔离迁移验证消费，不能用来构造业务写入口。

本次只明确既有组件、public facade 与数据定义，不重定义执行、授权或时序合同。保留已有低敏日志/错误/关联标识；完整组件、现有调用方与最终组合门按实际结果验证。
