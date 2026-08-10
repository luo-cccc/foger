import { existsSync } from "node:fs";
import { defineConfig } from "@playwright/test";

function resolvePlaywrightExecutablePath(): string | null {
  const override = process.env.PLAYWRIGHT_EXECUTABLE_PATH?.trim();
  if (override) {
    return override;
  }

  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    return candidates.find((candidate) => existsSync(candidate)) ?? null;
  }

  return null;
}

const executablePath = resolvePlaywrightExecutablePath();
const clientPort = process.env.INKOS_STUDIO_CLIENT_PORT?.trim();

if (!clientPort) {
  throw new Error("Run Studio E2E with `pnpm test:e2e` so it can allocate an isolated port.");
}

export default defineConfig({
  testDir: "./e2e",
  // Rebuild @actalk/inkos-core before starting the E2E server.  The API server
  // (tsx watch src/api/index.ts) imports core via its compiled dist/index.js,
  // not the TypeScript source.  A stale dist causes runtime behaviour to
  // diverge from the sources, making otherwise-correct logic invisible to the
  // test server.  See e2e/global-setup.ts for details.
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  timeout: 60_000,
  // Run specs serially against the single shared dev server. The authoring
  // agent flow streams a long SSE turn; with parallel workers, concurrent
  // specs hammering the one server starve that turn into a 60s timeout (the
  // spec passes alone but flakes in a parallel full run). Serial is both
  // reliable and faster here (one backend, no contention).
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${clientPort}`,
    headless: true,
    screenshot: "only-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
});
