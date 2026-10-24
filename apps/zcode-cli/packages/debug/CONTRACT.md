# Native debug observer

本组件只读取观测源并构造只读模型，不重新拥有执行状态、缓存事实或接纳队列。server 读取显式 log/event/SQLite/network 源；UI 渲染同一 read model，浏览器 transport hook 独占 EventSource / fetch 的关闭与错误状态。

- server/types 与 src/shared 是唯一观察数据定义，纯记录/usage 解释归 domain，文件/网络/数据库读取归 adapters；界面本地连接状态独立于业务 Run 事实。
- root contract 是读源入口；UI 不导入 server/repo/runtime 实现，不通过源文件聚合入口反向取型。observability trace/session/turn/span/toolCallId、来源 warning 与错误保持。
- 无新的持久化、执行、恢复、插件或授权副作用。迁移及原有 UI 布局/文字不变。受控 debug 可能携带正文，沿原观察源权限，不记录到新的普通日志。
- 合同测试用显式独立路径且新验证禁止读取真实默认数据目录；完整 debug API/analyzer/events/network 套件继续执行。
