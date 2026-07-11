import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const cleanBuild = args.has("--build");

const targets = new Set([
  ".cache",
  ".turbo",
  "coverage",
  "tmp",
  "output/playwright",
  "test-project",
  "packages/cli/node_modules/.vite",
  "packages/core/node_modules/.vite",
  "packages/studio/node_modules/.vite",
  "packages/studio/test-results",
  "packages/studio/playwright-report",
  "packages/studio/e2e-server.log",
  "packages/studio/e2e-server.pid",
]);

for (const entry of await readdir(workspaceRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith(".tmp-")) {
    targets.add(entry.name);
  }
}

if (cleanBuild) {
  targets.add("packages/core/dist");
  targets.add("packages/cli/dist");
  targets.add("packages/studio/dist");
}

for (const target of [...targets].sort()) {
  const absolute = resolve(workspaceRoot, target);
  if (absolute !== workspaceRoot && !absolute.startsWith(`${workspaceRoot}${sep}`)) {
    throw new Error(`Refusing to clean outside workspace: ${absolute}`);
  }
  const display = relative(workspaceRoot, absolute).replaceAll("\\", "/");
  try {
    await lstat(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (dryRun) {
    process.stdout.write(`CLEAN_DRY_RUN ${display}\n`);
    continue;
  }
  await rm(absolute, { recursive: true, force: true });
  process.stdout.write(`CLEAN_REMOVED ${display}\n`);
}
