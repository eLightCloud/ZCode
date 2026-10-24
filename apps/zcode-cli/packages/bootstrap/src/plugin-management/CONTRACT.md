# Native plugin management

本组件保留原生本地市场、配置、安装、校验、内置 seed/cache 与宿主 MCP 注入的唯一 writer。企业侧只提供自有 Git 目录及受信发行元数据，不复制安装器或执行授权。

- plugins.ts / contract 是插件操作公开入口；bundled-plugins 与 official-plugin-definitions 是既有装配/投影的具名能力。内部 seed lock、source pin、cache swap、超时、诊断及安装锁均保持原路径。
- App 只装配并消费本组件，不反向拥有内置源/缓存；存储布局由现有 adapters/storage 公共面统一转出，与原有函数逐字同体。不会将旧 ~/.zcode、配置/停用/修改过的插件重置为新默认，也不改技术 ID。
- 目录/市场检查、显式 install/refresh/update 和 enabled 分离；自有 Git 来源、用户自定义源、来源 repoint 拒绝和配置持久化按原合同。
- 保留观察和错误事件，trace 与操作诊断不下放密钥；本次不增加同步队列、迁移、权限绕行或 fallback。用隔离真实目录回归校验无写入，并复验原插件安装/更新/停用/恢复用例。
