import { defineConfig } from "vitest/config";

// 父配置只收集 test(s)/；本组件的 managed 合同必须沿同一测试入口实际执行。
export default defineConfig({
  test: { include: ["tests/**/*.test.ts", "src/contract.test.ts"] },
});
