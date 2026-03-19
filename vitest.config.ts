import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx", "apps/**/*.test.ts", "apps/**/*.test.tsx"]
  },
  resolve: {
    alias: {
      "@sandbox/ag-grid-translator": "/Users/matthewdavis/code/tanstack : ag grid/packages/ag-grid-translator/src/index.ts",
      "@sandbox/worker-store": "/Users/matthewdavis/code/tanstack : ag grid/packages/worker-store/src/index.ts"
    }
  }
});
