import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function findAvailablePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate an E2E port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const apiPort = await findAvailablePort();
const clientPort = await findAvailablePort();
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) {
  throw new Error("Studio E2E must be started through pnpm so the package runtime is available.");
}
const runtimeDir = mkdtempSync(join(tmpdir(), "inkos-studio-e2e-runtime-"));
const child = spawn(process.execPath, [pnpmCli, "exec", "playwright", "test", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: {
    ...process.env,
    INKOS_STUDIO_PORT: String(apiPort),
    INKOS_STUDIO_CLIENT_PORT: String(clientPort),
    INKOS_E2E_RUNTIME_FILE: join(runtimeDir, "runtime.json"),
    INKOS_E2E_LOG_PATH: join(runtimeDir, "server.log"),
  },
  windowsHide: true,
});

child.on("exit", (code, signal) => {
  rmSync(runtimeDir, { recursive: true, force: true });
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
