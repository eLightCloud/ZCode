import { applicationRootPlugin } from "./scripts/application-root-plugin.mjs";
import { resolve } from "node:path";
import {
  ROOT_TEST_INCLUDES,
  ROOT_TEST_EXCLUDES,
  integrationTestPatterns,
  isolatedIntegrationTests,
} from "./scripts/test-suites.mjs";

import { configDefaults, defineConfig } from "vitest/config";

// macOS 的 fsevents 在线程回收时曾触发 N-API SIGABRT；分类不改变既有进程隔离与原时限。
const unitPool =
  process.env.ZCODE_TEST_POOL ?? (process.platform === "darwin" ? "forks" : "threads");

export default defineConfig({
  // 企业装配补丁的 virtual Root 仍解析为原生默认实现，不改变官方测试选择策略。
  plugins: [applicationRootPlugin({})],
  // 测试固定注入事件上报端点，使遥测上报链路在单测中可验证；真实构建由 scripts/build-time-config.mjs 决定。
  define: {
    __ZCODE_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      // 间接 import desktopNetworkTelemetry 等的单测无需真实 ARMS；需 vi.fn 的用例在文件内 vi.mock 覆盖
      // Bugfix: 具体的 /browser 子路径必须排在包根别名前，否则会被根别名拼成不存在的 stub.ts/browser。
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // 官方 affected 图不额外追踪 setupFiles；公共 setup 必须触发全量选择，再由入口跳过 UT 并成功退出。
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      // 默认配置 glob 的尾部 /** 在当前版本不能匹配部分配置文件，补充文件模式。
      "**/{vitest,vite}.config.*",
      "**/vitest.setup.ts",
    ],
    // 修复原因：全量 run 的 stdout 会把**通过**测试里的 console 输出一并转发——services 层
    // 用 createServiceLogger 的用例在绿态下也要刷几千行多行日志，全量输出因此膨胀到
    // ~3.3MB，超过 CI/工作流门禁对单条命令 256KB 的 stdout 上限，导致门禁整条命令被判
    // 「无法执行」而非测试失败。passed-only 只隐藏通过测试的 console，失败用例的日志与
    // 断言 diff 原样保留（诊断能力不降级）；全绿时输出收敛到 ~140KB。
    silent: "passed-only",
    // 修复原因：全量单测并发跑 Git、zip、Electron 模块导入时，默认 5s 超时在低配或高负载机器上
    // 容易被提前打穿（spawn git 子进程、模块 import 变慢 → flaky 超时）；中断后的文件句柄清理在
    // Windows 上还会触发 EPERM/ENOTEMPTY。此前只给 Windows 放宽，但 macOS/Linux 低配机同样会因
    // 内存抖动（swap thrashing）拖慢 spawn，故统一降低并发并放宽超时。
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    // 修复原因：900+ 文件全部使用隔离 fork 时，macOS 会在尾部因连续创建进程而随机
    // 启动 worker 超时。普通用例使用 threads；会修改 cwd/umask、回收 POSIX 进程树或
    // 密集 spawn shell 的用例最后串行 fork，避免跨用例误杀、进程级状态竞争和系统
    // spawn 队列饥饿。
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ROOT_TEST_INCLUDES,
          exclude: [...ROOT_TEST_EXCLUDES, ...integrationTestPatterns],
          pool: unitPool === "forks" ? "forks" : "threads",
          maxWorkers: unitPool === "forks" && process.platform !== "darwin" ? 2 : 4,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: integrationTestPatterns,
          exclude: [...ROOT_TEST_EXCLUDES, ...isolatedIntegrationTests],
          pool: unitPool === "forks" ? "forks" : "threads",
          maxWorkers: 4,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "integration-isolated",
          include: isolatedIntegrationTests,
          exclude: ROOT_TEST_EXCLUDES,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
      "packages/zcode-cua/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
