import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@actalk/inkos-core/llm/agent-model-routing": resolve(__dirname, "../core/src/llm/agent-model-routing.ts"),
      "@actalk/inkos-core": resolve(__dirname, "../core/src/index.ts"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    // server.ts is large enough that first-load esbuild transforms can exceed
    // Vitest's default 5s timeout on a cold full-suite run.
    testTimeout: 30_000,
  },
});
