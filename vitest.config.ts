import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/background/**/*.ts", "src/shared/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/background/index.ts",
        "src/background/chrome-*.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
