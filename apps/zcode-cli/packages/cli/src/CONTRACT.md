# Native CLI process entry

本组件只拥有进程/终端入口、参数到原生 app 的装配、stdout / stderr 与退出码，不拥有执行或企业授权。参数解析细分组件继续保留。

- 终端、进程 env、TTY、信号、Node 子进程和 console 操作是本组件 adapter 职责，不将 Core / Bootstrap 整棵 CLI 标为 adapter。
- run / contract 是固定公开能力；CommandCenter 的类型从现有 types 定义消费，不通过构造聚合入口反向取型。
- JSON/event stdout 与诊断 stderr、信号取消与子进程回收、deadline、workspace identity、trace 关联保持原合同。品牌仅修改应用文案，不改 zcode 命令、参数、协议或存储身份。
- 合同回归验证明确输出格式拒绝错误配置，完整 CLI 包继续执行所有原用例，不扩超时、不减少用例。
