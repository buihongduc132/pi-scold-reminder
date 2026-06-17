import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["extensions/**/*.test.ts"],
    exclude: ["extensions/index.test.ts", "node_modules", "dist"],
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["extensions/**/*.ts"],
      exclude: ["extensions/index.ts", "extensions/**/*.test.ts"],
      thresholds: {
        lines: 85,
        branches: 85,
        functions: 80,
        statements: 85,
      },
    },
  },
});
