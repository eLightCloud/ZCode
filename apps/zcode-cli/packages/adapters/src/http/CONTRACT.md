# Native network I/O

复用既有 HTTP client、响应体清理、Proxy/TLS 配置和子进程出口环境实现。同步适配、MCP、模型和插件 Git 各有真实调用方，本模块只统一既有网络 IO 边界，不增加全局 util 或第二请求栈。

唯一公开 facade 是既有 http/index.ts；原生 HttpClientPort 和 NetworkEgressEnvPolicy 保留唯一类型来源。调用者持有准确目标、取消信号及用途，网络适配只执行原超时、大小、代理、CA、公共出口与错误规则，不裁决企业授权。

conversation-sync 保留更细的正文 / outbox writer；它依赖本公开 HTTP 面而不依赖包内其他 IO factory。父级 adapters 的合成 checks 可调用同步 facade，不形成同步对父装配的反向依赖。Node HTTP 的请求 / 响应类型仍用于服务端接合，不把它当成新的执行协议。

没有新增环境配置、定时器、缓存或日志清洗。原请求关联、错误类别、body 清理与脱敏沿原实现，源自本轮独立用例的输入仅使用 .test / 临时合成路径。
