# Pre-push Hook

仓库现在通过 Husky 接管 Git 的 `pre-push`。

组织推送策略要求每个准确源码和工具链组合先实际执行完整的隔离单元 / 组件套件 `pnpm test:unit`。用户于 2026-10-30 授权验证前置与成功凭证复用，取代每次传输重试都重复全量的旧规则。用户于 2026-10-26 明确授权将真实 IO、数据库、网络、子进程和构建集成从 push 中拆出；原来“完整根测试全部进入 push”的规则由本分层取代。静态检查与单测失败仍阻止 push，affected 保留独立开发命令，不再进入推送链；成功凭证不能由 affected 产生。

## 普通 git push 的自动入口

日常只需 `git push`。prepare 自动安装仓库级 SSH 桥，receive-pack 在真实建连前进入同一验证 owner；匹配成功结果直接复用，失败阻断。fetch / pull / SSH -G 透传，不触发验证。安装固定 Node，hook 使用相同运行时；不覆盖已有自定义 SSH 命令，不修改全局配置。SSH 桥保存在 Git common 元数据目录，避免依赖某个 worktree 的路径；读取操作不依赖当前分支含有验证源码。

验证命令的 stdout 和结构化事件在 SSH 模式下全部写入 stderr，SSH stdout 只传输 Git 协议。SSH 进程退出只代表连接过程，最终推送结果由 Git 返回；不能把 receive-pack 的成功退出冒充所有 ref 已更新。

仅自动接合已配置的 SSH 来源。显式 GIT_SSH_COMMAND、HTTPS 或自定义 receive-pack 不经该前置桥，pre-push 继续拒绝无凭证推送；旧显式入口保留诊断 / 兼容用途，不再是日常要求。安装 / doctor 必须核验 SSH 桥与固定 Node 的有效性。prepare 在没有 Git 元数据的源码包中或显式 HUSKY=0 的容器构建中只跳过推送入口安装，不影响后续构建；check-install 与真正推送仍拒绝缺失或禁用的门禁。

## 测试分层合同

| 入口 | 范围 | 自动进入 push |
| --- | --- | --- |
| `pnpm test:unit` / `pnpm test` | 隔离单元、内存组件和只读源码守卫；所有业务 IO 由替身提供 | 新输入签发凭证前 |
| `pnpm test:integration` | 真实临时文件 / SQLite、HTTP / WS、子进程及构建 / 打包 | 否 |
| `pnpm test:all` | 两套根测试及 schema / 工程门禁自身回归，任一失败非零退出 | 否，显式完整回归 |
| `pnpm test:e2e` | 原有桌面 E2E 入口 | 否 |

分类由 `scripts/test-suites.mjs` 唯一拥有，根 Vitest projects 按同一清单构成互不重叠的单元与集成集合。只读源码断言、mock RPC 和 jsdom 组件属于单测；导入 IO 类型、使用替身或文件名包含 integration 不自动成为集成。一个文件包含真实 IO 用例时，整个文件归集成；拆成更小文件后可以分别归属。混合测试按真实调用链分类，不按运行时间或是否偶发失败分类。

新集成测试使用 `*.integration.test.ts` 或 `test/integration/` 约定；存量文件由清单登记。改变分类必须核对实际依赖，并验证完整收集集合守恒及两个套件互斥。`test:suites:check` 在 push 中只枚举文件与 project，不加载测试正文；重复、遗漏或失效分类均阻断。原有需串行的真实进程 / 原生模块测试仍串行运行；进程池策略与测试类别分别表达。工程 gate 的真实 Git / 工具子进程回归保留 `test:architecture` 独立入口，并由 `test:all` 包含；需要执行真实迁移的 `db:schema:check` 同样由 `test:all` 承接，不进入 push。

所有根 Vitest 测试入口继续通过现有 HOME / XDG 隔离 runner，scope 与实际 project 选择写入低敏事件；不得用直接 Vitest 绕开隔离。集成缺少依赖或失败必须非零退出，不能改成 skip；原有平台适用性跳过保持。该分层不新增或修改远端 CI 配置，可由 CI 显式调用 `pnpm test:all`。

- 安装依赖后会执行根脚本 `pnpm prepare`，自动完成 Husky 安装。
- 普通 `git push` 自动在真实 SSH 建连前验证；`pre-push` 只快速核验匹配凭证。
- 根 `pnpm test` 现在只跑单测，不再误把桌面端 `packages/desktop/test/e2e` 当成 Vitest 用例。
- Bugfix：单测脚本里的 E2E exclude glob 必须加引号；否则 shell 会先把 `packages/desktop/test/e2e/**/*.test.ts` 展开成真实文件列表，导致 Vitest 把多余文件当成 filters，同时又被 exclude 排除，最终报 `No test files found` 并阻止 push。
- `verify:pre-push` 依次执行 lint、完整架构静态检查、收集守恒检查、完整隔离单测；任何失败阻止 push。完整架构检查使凭证不依赖某个远端基线。

这样可以在代码推到远端前，先用更快的静态检查拦住明显问题，再把单测问题拦在本地，同时保留 `pnpm test:e2e` 作为桌面端 E2E 的独立入口。

## 验证前置与成功凭证

唯一编排为 `scripts/verified-push.mjs`，唯一仓库策略为 `.push-verification.json`。日常 `git push` 自动进入同一验证 owner；旧 `pnpm push` 仅保留显式诊断与非 SSH 兼容。`--force-verify` 放在 remote 前可强制重新验证。正常 SSH 推送无凭证时由前置桥自动验证；若安装缺失或显式覆盖 SSH 桥，pre-push 仍会立即拒绝无凭证推送，不在连接后启动长测试。单独运行 `pnpm verify:pre-push` 保持显式质量门，不签发凭证。

凭证只保存在当前仓库的 Git 元数据 `verified-push/`，不提交或跨机器共享。指纹包含干净已提交源码树、递归子模块及 gitlink 一致性、平台 / 架构、实际 Node 路径与版本、策略声明的工具版本、依赖安装元数据、相关环境及编排实现。任何输入改变必须重新验证；dirty / 未跟踪源码、缺失或错位子模块、工具不可用都阻断。推送只放行当前 HEAD（允许删除 ref），不支持批量其它分支或注解 tag。远端、分支名、SSH 连接配置不属于与目标无关的质量门输入；服务端拒绝、断网或 SIGPIPE 后，同输入重试复用成功凭证。

验证开始前获取本机目录锁，防止并发签发；全部检查成功且前后输入相同才原子写入凭证。失败、中断或输入变化不签发；强制重验先撤销旧凭证，失败后不得沿用。异常杀进程留下锁时，先确认没有该仓验证进程，再删除 `git rev-parse --git-path verified-push/lock` 指向的锁目录并重试，不自动抢占活跃验证。

hook 复核有效 hooksPath、成功凭证、当前指纹与待推 HEAD；入口禁止 `--no-verify` / `-n`、关闭 Husky 及批量推送选项。hook 是本机工程保护，不能代替远端分支保护。日志 `engineering.git.push` 以关联 ID 区分验证开始 / 失败 / 通过 / 复用、hook 准入与传输结果；指纹和退出码可记录，不输出配置秘密或工具异常正文。

```text
git push → SSH 前置桥 → 指纹 / 成功凭证 → 必要时完整验证
         → 真实 SSH 连接 → pre-push 快速复核 → Git 原生传输结果
```

安装按已准备好的 Node / pnpm 环境记录准确 Node 路径，日常 SSH 入口与 hook 使用该固定 Node；验证子进程沿既有跨平台 runner 固定相同 Node。原生独立仓库不强制安装 mise；重新安装或升级工具时更新登记，实际版本变化使凭证失效。Vantage 外层入口通过既有 mise 固定工具。GUI 应先在终端用受控入口验证，之后同输入的普通推送可以复用；无法取得 Node / pnpm 时明确失败，不能静默跳过。mise、隔离 runner 和测试失败规则继续保留。

## Affected Unit Tests

### 目标与入口

`pnpm test:unit:affected` 使用 Vitest 官方 changed/related 和 Vite 模块依赖分析。薄入口只负责 Git 基线、Push 工作区检查、全量跳过和结果说明；不维护自建依赖图、基线消费者图、来源过滤或 Node 测试选择。

| 入口                                         | 官方选择范围                                                                       |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm test:unit:affected`                    | `changed: true`，包含已暂存、未暂存、未跟踪文件                                    |
| `pnpm test:unit:affected --base <commit>`    | `changed: <SHA>`，包含任务起点之后的提交及当前未提交改动                           |
| `pnpm test:unit:affected --scope push`       | 显式基线优先；默认用 hook remote SHA，首次推送用 HEAD 与 origin/main 的 merge-base |
| `pnpm test:unit:affected --files <files...>` | 官方 related，供 lint-staged 等显式文件入口使用                                    |
| 上述入口加 `--dry-run` / `--dry-run --json`  | 预览官方选中的测试文件；JSON 只包含测试清单                                        |

任务开始记录一次 HEAD SHA；任务结束使用该起点。开始前已有未提交改动全部纳入；不保存或扣除初始 patch。官方 changed 使用 Git 的三点比较和当前未提交文件，合并带入的改动正常参与选择，不做来源过滤或额外净差异运算。

Push 要求已暂存、未暂存、未跟踪改动均为空（忽略 Git 已忽略的文件）。不干净时非零退出，不自动 stash 或创建 checkout，保证执行内容就是推送版本。hook 非删除 ref 必须指向当前 HEAD；多个 ref 通过各自基线调用官方选择，再合并精确测试规格。删除 ref 无需测试。手动 push 模式没有 hook 输入时使用 upstream；没有有效 upstream 时使用 origin/main 的 merge-base。不存在可用基线、需要使用的 remote SHA 无效、目标不是 HEAD 均非零退出。显式基线优先于 hook remote SHA；未提供显式基线时，新分支基线只使用 origin/main，不猜测其他分支。

所有模式的基线优先级均为 `--base` → `ZCODE_AFFECTED_TEST_BASE` → `ZCODE_PRE_PUSH_BASE` → 场景默认基线。`ZCODE_AFFECTED_TEST_BASE=<ref> pnpm test:unit:affected --scope push` 使用指定分支、tag 或 commit 的已解析 SHA 交给 Vitest changed；不把 staging 等分支名写死。即使指定基线，Push 仍须工作区干净且非删除目标是 HEAD。显式基线无效时报错，不回退到 remote SHA。

默认工作区没有显式基线时不读取 upstream。--files / --files-manifest 使用官方 related，不与 --base 或 push 混用。

### 选择与执行

```text
场景与基线 → Push 工作区检查 → Vitest 官方选择 → 与完整根 UT 规格比较
                                                     ├─ 0 个：说明，exit 0
                                                     ├─ 部分：执行同一份规格清单
                                                     └─ 全部：说明原因，跳过 UT，exit 0
```

- 粒度为测试文件；选中文件后执行文件内全部 case。根配置的 unit 与 cua-placeholder 项目构成完整单测套件，排除 desktop E2E，不含 CLI 独立测试；scripts 下的 Node 原生测试另用 node --test，不自动关联。
- 使用公开 getRelevantTestSpecifications 选择；globTestSpecifications 提供完整清单。预览只转换模块，不 collect/import 测试；执行使用同一 Vitest 实例和同一份精确规格，避免 CLI 文件名子串匹配扩大范围。
- 官方 forceRerunTriggers 保留默认配置，补充配置文件模式 `**/{vitest,vite}.config.*`（当前默认 glob 尾部 `/**` 未匹配部分配置文件），再加入公共 vitest.setup.ts。原因：官方模块依赖分析不会额外纳入 setupFiles；公共 setup 改动必须作为全量影响，由入口说明并跳过 UT，成功退出。
- 全量指选中完整套件（按 project/pool/path 识别规格），不是任意数量阈值。大量真实关联测试若未覆盖完整套件，照常运行。即使是 dry-run / JSON，选中整个非空套件说明后成功退出，不因此阻止 Push。
- 无选中测试说明后 exit 0；这不代表所有改动已验证。官方依赖识别的限制照常适用，不增加字面量文件读取、类型依赖、删除文件基线等自建补偿。
- 选择精度靠准确的模块图，不靠选择规则：官方选择是文件级传递闭包，经由 barrel 的 `export *` 会把一个模块的改动传给所有导入 barrel 的测试。高扇入的纯常量模块因此只走子路径，不进根 barrel。`packages/shared/src/test-ids.ts` 的常量只从 `@zcode/shared/test-ids` 导入，根入口不再 re-export，从根入口导入这些常量会被 typecheck 拒绝；工作流一族 `test-ids-workflow.ts` 仍由根入口导出，不在本规则内。原因：根入口由 100 多条 `export *` 汇总，改 test-ids 曾选中 1379/2638 个测试，其中直接引用 test-ids 的约 50 个。
- 测试失败 exit 1；Git、参数、基线、Vitest 错误以及脏工作区 exit 2；全量跳过 exit 0，不代表测试通过。绝不自动回退全量、追加全量重试或静默吞掉选择器异常。pnpm test / pnpm test:unit 保持完整单元套件入口；pnpm test:all 显式运行完整验证。
- 输出选中数量与基线；跳过全量时说明官方选中整个套件，列出官方 related 改动文件。dry-run 列精确规格，JSON 包含 runner/project/pool/path，不伪造逐文件关联原因。
- Git/文件操作异步；保留 hook local env 清理和 lint-staged JSON manifest，Windows 不经 shell 展开文件名。不修改工作区和 index。

全量跳过适用于工作区、任务结束、Push 和显式文件入口。独立 affected push 范围的脏工作区、基线及实际局部测试失败仍会非零退出；跳过全量只表示该独立命令未执行 UT，不签发推送凭证。

### 回归验收

以下是独立 affected 命令及其合成 hook 夹具的回归，不代表当前受控推送入口或成功凭证的行为。

使用临时 Git 仓库、真实 Vitest 和命令入口验证：局部选择与预览/执行一致、未选择文件不执行、任务跨 commit 与旧 WIP、新增测试、配置与公共 setup 全量跳过、共同依赖全量跳过、真实 git push 在全量跳过后成功推送、无关联成功退出、测试失败、无效基线、首次/已有分支 Push、脏工作区和非 HEAD 推送阻止、多个 ref 与删除 ref、集成合并正常参与选择、lint-staged manifest 和 Git local env 隔离。夹具移除外层 push/基线环境后再注入本场景参数，避免真实仓库 SHA 污染临时仓库。

### 时序与真实子进程测试

- 计时算法用受控时钟和数据事件验证先后顺序；真实 IO 接线通过独立集成入口覆盖，不把进程启动排队计入很短的算法测试窗口。
- 真实子进程的关闭测试先等待夹具在注册退出处理器后发出的 ready 事件，再开始关闭计时；固定 sleep 不能证明子进程已就绪。
- 必须在短窗口内启动独立 Node、显示服务进程树或原生依赖的集成测试，放入 `vitest.config.ts` 的 `integration-isolated` 组。该组在集成入口中按单文件串行执行；保留真实进程、原断言和超时值，不跳过用例。
- 远控前端选源的 CI shell 集成测试会连续启动 Git、Bash 和 Node，归入上述串行组，保留真实选源、构建接线、清理验证和原 30 秒超时。
- 原生文件监听的集成测试也在串行组验证真实事件送达；通知去重与事件顺序使用受控 watcher 事件单独验证，避免把逻辑断言绑定到系统事件的调度时机。Gen UI 状态覆盖外部写入、重复文件事件、同值写入 ACK，以及读取最新状态后仍能收到通知。
- 正常完成同时断言退出码、`timedOut: false` 和 `aborted: false`。取消或截止不能把信号退出当作成功；资源清理断言应确认只移除本次创建的资源。

```text
unit（受控事件/时钟）
集成入口：integration → integration-isolated（真实进程，单文件串行）
                                     └─ 正常结束 / 取消 / 截止 → 核对状态与资源清理
```

### CLI 原生测试环境

CLI workspace 的 build / clean / typecheck 入口显式通过当前 Node 加载根 workspace 的既有 Turbo，不要求嵌套 workspace 自带重复 shim。TUI 测试使用已选定的 Node 通过 `--import tsx` 加载现有 loader，避免嵌套 CLI workspace 的 bin 搜索遗漏根工具；不依赖额外临时 PATH。CLI 的 Node 原生测试以 `--test-concurrency=1` 逐文件运行，避免真实子进程启动与其他测试文件争用资源；保留全部用例及各自原超时。内置搜索的取消夹具在退出处理器就绪后写 PID，失败清理也必须取消并等待子进程结束，不能让首个断言失败留下存活句柄。

affected 只选择根 Vitest UT，工具 Node 测试另行执行，不代替 CLI 的原生 `pnpm --filter zcode-cli test`。CLI 的 CUA 同步测试使用明确传入的 `ZCODE_CUA_REPO` 定位 producer checkout，Turbo 的 test task 将其计入缓存键并传入测试；不记录本机绝对路径，不更改 producer pin。`VITEST_MAX_WORKERS` 同样传入并参与缓存键，资源受限的全量验证可显式限制单套件并发，不能靠扩大超时掩盖断言失败。

CLI 全量入口通过 pretest 构建根 workspace 的 `@zcode/model-option-map` 与 `packages/shared` 的正式 TypeScript 产物，确保 SEA 测试从干净 checkout 也能读取运行时资源；不能依赖先前手动构建的 dist。

CLI `pnpm test` 和根 `pnpm test:unit` / `pnpm test:integration` / `pnpm test:all` 的 Vitest 阶段共同使用 `scripts/run-isolated-tests.mjs`：在启动测试进程前分配独立 HOME / USERPROFILE / XDG 目录，保留调用者已经固定的 Node 与 PATH；根单测仍排除 desktop E2E，CLI 仍执行全部 Turbo test task，参数、失败退出码和测试原时限保持。成功与失败均清理本次临时目录。不要以直接执行 Turbo / Vitest 来替代这两个全量入口：只设置 storage.dir 或两条已知夹具的 dbPath 不能保护其它默认路径调用。相关低敏启动 / 结果 / 清理事件只记录 scope、关联 ID 和临时目录引用，不记录个人配置或正文。CLI Turbo 显式透传这些目录变量，测试输入包含隔离入口源码，防止缓存跨越隔离实现变更。必须实际全量复验时传 `--force`，不得把缓存结果标为本轮新执行。此隔离不回滚历史测试已经发生的默认库变化，也不宣称所有单独运行的测试命令都已具备同一隔离。

### Docker test grouping

The desktop E2E container entry groups both driver prefetch and test containers
under `COMPOSE_PROJECT_NAME` in Docker Desktop (default: `zcode-tests`). Product
launchers may provide their own project name. This is presentation metadata;
existing unique names, networks, volumes, and cleanup ownership remain unchanged.

### macOS 全量测试进程

macOS 根单元与集成默认采用 forks（普通组 4 个 worker，integration-isolated 单文件串行），以隔离 fsevents 的原生 N-API 回收。真实 threads 全量的崩溃报告显示 uv_mutex_lock / napi_release_threadsafe_function / fse_instance_destroy 引发 SIGABRT；相同范围 forks 完整通过。ZCODE_TEST_POOL 可显式选择诊断池，其他平台默认沿 threads。此配置不删除测试、改变断言、扩大超时或失败后自动重试。隔离入口统一记录实际 termination_signal；信号终止仍返回失败并阻止 push，成功 / 失败均清理自身临时目录。
