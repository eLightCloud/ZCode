# 自动化运行的会话恢复

## 合同

原生 AutomationRepo 是 run → session 身份的唯一持久 writer。没有固定 targetTaskId 的运行，在任何会话创建前以原 runId 原子固定一个 sessionId，写入既有 automation_runs.session_id；重复调用只能读回原值。下一次运行分配另一身份，不按日期去重。不增加企业调度器或第二映射表。

dispatcher 将固定身份传给 createTask 的可选 sessionId。该参数只用于已有调用方明确管理身份的创建／恢复：adapter 先沿公开 resumeTask 恢复准确身份（包括热 deferred 会话）；只有明确返回该 ID 的 Session not found 才沿原 createSession 透传该 ID。超时、busy、配置故障不按不存在处理；并发创建冲突不换 ID。v4Create 不能同时使用此参数，其命令身份仍沿 v4 owner。

CLI 既有 createSession 拒绝覆盖现存／软删会话；本改动不改变该屏障。deferred 会话在首条输入前进程丢失时可重新物化同一身份；已保存／已有输入的会话只能恢复。会话创建回执丢失不会产生第二个逻辑会话。

派发、重试、崩溃恢复始终以原 runId 作为 inputId/traceId。输入去重继续归 CLI CommandInbox，不由 Host 保存第二队列。外部效果的幂等仍归外部工具；本合同不声称任意工具 exactly-once。新会话不会读入旧任务聊天；共享文件和项目记忆不构成安全隔离。

绑定 targetTaskId 的旧行为不变；普通 createTask 未传 sessionId 的路径不增加枚举或恢复。未启用企业接合也遵守相同原生恢复语义。桌面 continuous 和 Web/mobile replayable 保持各自原 clientMode、owner/lease 及传输边界。

恢复预留身份时，可选 refreshConfiguration 仅透传可信接合本次真实配置变化；不因预留身份或 automationId 自动刷新。新建时按当前配置物化，已有会话仍服从原生刷新忙状态屏障。

## 验收

- 两个 run 固定不同身份；同 run 重复／冷启动保持原身份。
- 会话创建后、sendPrompt 前失败，再次派发只恢复原会话，输入 ID 不变。
- 创建响应丢失、并发创建、查询故障均不生成替代身份。
- 绑定会话、无企业接合、普通创建不改变默认行为。
- 发送回执丢失由原 inputId 去重；未知外部邮件不换 ID。
- 日志关联 automationId/runId/sessionId，区分预留新身份与复用，不记录 prompt。

实现范围：automationDispatcher、automationRepo、zcodeTaskService 创建参数及 zcodeTaskServiceAdapter，配套原生测试；2026-11-16 用户已明确授权这一通用恢复补丁。
