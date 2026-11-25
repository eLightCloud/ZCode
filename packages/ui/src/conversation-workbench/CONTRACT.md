# conversation-workbench

既有历史与接续视图。服务端/Core 是正文、接纳、operation 与激活事实 owner；hook 只保持可撤销读取、generation、用户尚未提交意图与服务端确认的呈现，不承接第二 accepted queue。组件经同一 reader/原 hook 访问，不直接访问 Repo 或平台 native API。两端交付、账号撤销后清空、未知 ACK 重查、授予后取消边界与 onReady 路由保持原合同。文案从 labels 注入，品牌不改变协议/技术身份。

本次只明确既有组件、public facade 与数据定义，不重定义执行、授权或时序合同。保留已有低敏日志/错误/关联标识；完整组件、现有调用方与最终组合门按实际结果验证。

同一 useConversationHistory owner 可同时服务 ConversationSidebar 和 ConversationHistory 的准确 session 详情。侧栏只补充 nativeSessionIds 尚未呈现的中心记录，不伪造 ZCodeTaskMeta、时间、cwd 或项目。只读点击打开正文，不申请执行；版本和继续动作沿原 reader。详情接受共享 history 时不得建立第二读取 owner。

选中 session 复用原生消息与 ChatPromptEditor。只有一个候选版本时，侧栏和详情读取该版本的正文。存在多个候选时由用户查看内容并选择。提交追问后，当前执行位置可打开且没有待决操作时沿用该位置。在线原位置和所选位置不同时，用户明确选择目标，交接请求使用当前代次的执行基线和用户查看过的候选集合。候选变更后重新展示最新内容。目标仅包含调用窗口可打开的位置。服务端确认就绪后，按同一 session 的实际原生工作区打开，草稿由原生输入框保留，用户确认发送。失败可重查原 operation，离线接续须另行确认。

工作台通过 ApplicationPeripherals.conversationPreview 提供当前查看的已保存会话标识和标题。标题、保存图标与侧栏选中项共同指向该会话。接续成功后，原生工作台恢复展示目标任务自己的操作。

原位置查看已交接任务时，由当前任务 ID 定位中心已保存正文。可见的单一候选随中心版本更新。刷新时保留输入框和滚动容器，比较或确认期间固定已展示版本。读取既不供给位置也不提交输入；失去身份时清除旧正文，切换任务后丢弃晚到的读取结果。

ConversationHistoryLabels.sidebarUnavailable 可提供侧栏简短失败摘要；侧栏摘要与刷新保持同一行，不渲染 readError 排障长文。其它会话视图及日志继续使用已有类型化错误。

ConversationSaveIndicator 是无状态的已保存 / 分歧图标投影，复用原生图标与 tooltip；标签由调用方本地化，作为悬停说明和读屏名称，不显示第二行状态正文。
