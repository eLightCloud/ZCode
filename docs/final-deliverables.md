# 明确文件交付与不可变快照

## 目标与 owner

最终文件交付使用显式 `DeliverFiles` 工具，不从 Markdown 路径、目录修改或预览候选推断。
原生文件交付能力拥有交付声明、版本、不可变快照及其公开查询；CLI 工具负责接纳声明，
Node 存储适配负责文件 IO。Host / Server 通过公开协议读取；应用可消费交付，不能修改
原生任务、accepted input 或执行恢复。通用合同不包含企业名、租户、Bucket、配额和业务凭据。

## 声明与快照

- 仅对明确交给用户的普通文件调用工具；输入资料、中间文件和尚未由主会话交付的子代理输出不自动交付。
- 每项声明绑定准确 workspace 身份、session / turn、工具调用键、文件名和明确输出用途。
- 原生适配校验真实路径和工作区边界，按稳定文件句柄复制，流式计算实际长度及 SHA-256；
  越界、非普通文件、复制期间变化和取消明确失败。不能用工作路径作为历史快照。
- 快照与最小声明先持久化，再返回成功；查询不依赖生成文件继续存在或会话仍在内存中。
- 同一调用重放返回原交付；相同调用键不同声明冲突。有准确前序引用才产生交付修订，
  不同会话同名文件默认独立。新修订不覆盖旧字节。

## 公开读取与生命周期

公开能力提供有界分页清单、按稳定交付 / 版本取得描述符、按范围读取原始字节。
分页完整性以持久进度水位为准；通知只负责唤醒，不能丢失重启期间的交付。
描述符不暴露私有存储定位，读取拒绝伪造 ID、非法范围和越界读取。

原生持久化在本机 / 受管来源实例的原生私有目录；应用消费意图属于外部应用自身，
不写原生私有表。应用退出、断线或上传失败不修改原生任务状态。

```text
明确文件 → CLI 交付入口 → 原生快照与持久清单 → 公开协议 → Host / Server → 应用消费
                            ↑ 查询水位恢复；事件仅唤醒 ↑
Desktop continuous 与 Web replayable 继续使用各自原生执行传输，文件读取不改变输入语义。
```

## 端到端验证

覆盖 CSV / ZIP / 图片 / 零字节、超过预览数量、多文件部分失败、越界及符号链接、
复制期间变化、重复调用、明确修订、冷启动清单 / 字节重读、会话删除后的独立快照。
同一公开能力分别经本机与独立 Server 验证；未运行的平台不视为通过。

## 应用 Host 接合合同

`IZCodeAgentService.listDeliverables/readDeliverable` 仅调用原生公开协议，不创建会话或启动模型。
可配置的应用 Host 扩展由受信任启动装配提供绝对模块路径；未配置时不加载应用逻辑。
扩展只持有应用自己的保存意图、水位和凭据引用，可使用上述读取能力。
通用 Host 在 `sendPrompt` 前给扩展传递 workspace/session/input 的关联引用；不传 prompt 或附件。
应用身份必须在该输入发送前绑定；离线与身份切换后的旧交付不能按扫描时的当前身份重新归属。
应用扩展释放须先停止轮询与上传，再释放原生服务。

## Snapshot release

The native owner exposes release for an exact workspace/id/version and expected
SHA-256. Release removes only those snapshot bytes and retains the immutable
declaration as a tombstone for replay and cursor continuity. Repeated release is
idempotent; read then reports snapshot released. Applications may release only
after a durable accepted receipt or an explicit user decision; failed/unknown
uploads retain their snapshot. The application journals its release completion
and retries after restart, without unlinking native files itself.

Node SQLite is imported through its standard built-in module entry. The Desktop
Agent ships a CommonJS bundle: evaluating import.meta.url to construct require
is invalid there. Source ESM tests alone do not prove storage-only bundle startup;
validate the built CLI in a Host Worker before claiming Desktop readiness.
