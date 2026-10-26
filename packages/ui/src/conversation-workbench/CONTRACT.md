# conversation-workbench

既有历史与接续视图。服务端/Core 是正文、接纳、operation 与激活事实 owner；hook 只保持可撤销读取、generation、用户尚未提交意图与服务端确认的呈现，不承接第二 accepted queue。组件经同一 reader/原 hook 访问，不直接访问 Repo 或平台 native API。两端交付、账号撤销后清空、未知 ACK 重查、授予后取消边界与 onReady 路由保持原合同。文案从 labels 注入，品牌不改变协议/技术身份。

本次只明确既有组件、public facade 与数据定义，不重定义执行、授权或时序合同。保留已有低敏日志/错误/关联标识；完整组件、现有调用方与最终组合门按实际结果验证。

同一 useConversationHistory owner 可同时服务 ConversationSidebar 和 ConversationHistory 的准确 session 详情。侧栏只补充 nativeSessionIds 尚未呈现的中心记录，不伪造 ZCodeTaskMeta、时间、cwd 或项目。只读点击打开正文，不申请执行；版本和继续动作沿原 reader。详情接受共享 history 时不得建立第二读取 owner。

选中 session 复用原生消息与 ChatPromptEditor，不增加版本管理页。多候选在会话中读取实际内容并供必要选择；后续输入是未接纳草稿，只有明确提交 / 当前会话明确选择才挂载既有 continuation hook。候选变化拒绝旧决定，唯一目标自动沿原 owner 准备 / 恢复；离线风险仍需明确确认。目标与输入导航经公开端口，草稿由既有 composer owner 保存，不创建 accepted queue、不自动发送。失败可重查原 operation；确认取消之前不能新开离线操作。

ConversationHistoryLabels.sidebarUnavailable 可提供侧栏简短失败摘要；侧栏摘要与刷新保持同一行，不渲染 readError 排障长文。其它会话视图及日志继续使用已有类型化错误。

ConversationSaveIndicator 是无状态的已保存 / 分歧图标投影，复用原生图标与 tooltip；标签由调用方本地化，作为悬停说明和读屏名称，不显示第二行状态正文。
