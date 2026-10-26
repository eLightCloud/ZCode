import { defineConfig } from "vitest/config";

// 根单测引用固定项目入口；缺失此文件会在发现公共测试前直接终止。
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: "cua-placeholder",
    include: ["test/**/*.test.ts"],
    // 独立单元项目；无需调度真实 IO 集成组，worker 数保持不变。
    maxWorkers: 1,
    sequence: { groupOrder: 0 },
  },
});
