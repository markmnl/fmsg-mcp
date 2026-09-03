import { defineConfig } from "vitest/config";

const e2e = process.env.FMSG_E2E === "1";

export default defineConfig({
  test: {
    include: e2e ? ["test/**/*.e2e.test.ts"] : ["test/**/*.test.ts"],
    exclude: e2e ? [] : ["test/**/*.e2e.test.ts", "node_modules/**"],
    testTimeout: e2e ? 180_000 : 20_000,
    hookTimeout: e2e ? 60_000 : 20_000,
  },
});
