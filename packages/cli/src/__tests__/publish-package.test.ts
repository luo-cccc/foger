import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliDir = resolve(testDir, "..", "..");
const workspaceRoot = resolve(cliDir, "..", "..");
const studioDir = resolve(workspaceRoot, "packages", "studio");
const CLI_PACK_TEST_TIMEOUT_MS = 30_000;
const STUDIO_PACK_TEST_TIMEOUT_MS = 120_000;
const sourceCliPackageJsonPromise = readFile(resolve(cliDir, "package.json"), "utf-8").then((raw) =>
  JSON.parse(raw),
);
const sourceStudioPackageJsonPromise = readFile(resolve(studioDir, "package.json"), "utf-8").then((raw) =>
  JSON.parse(raw),
);

function tarForceLocalArgs(): string[] {
  if (process.platform !== "win32") return [];
  try {
    const version = execFileSync("tar", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return version.includes("GNU tar") ? ["--force-local"] : [];
  } catch {
    return [];
  }
}

async function packPackage(
  packageDir: string,
  packDir: string,
  options: { readonly ignoreScripts?: boolean } = {},
) {
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const cacheDir = join(packDir, ".npm-cache");
  const npmArgs = [
    "pack",
    "--silent",
    "--pack-destination",
    packDir,
    "--cache",
    cacheDir,
    ...(options.ignoreScripts ? ["--ignore-scripts"] : []),
  ];
  const invocation = process.platform === "win32"
    ? {
        command: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", npmCmd, ...npmArgs],
      }
    : { command: npmCmd, args: npmArgs };
  await mkdir(cacheDir, { recursive: true });
  execFileSync(invocation.command, invocation.args, {
    cwd: packageDir,
    env: process.env,
    encoding: "utf-8",
    stdio: "pipe",
  });

  const tgzFiles = (await readdir(packDir)).filter((name) => name.endsWith(".tgz"));
  if (tgzFiles.length !== 1) {
    throw new Error(`Expected exactly one tarball in ${packDir}, found ${tgzFiles.length}`);
  }

  return join(packDir, tgzFiles[0]);
}

async function extractPackedPackageJson(packageDir: string, packDir: string) {
  const tarballPath = await packPackage(packageDir, packDir);
  const tarArgs = [...tarForceLocalArgs(), "-xOf"];
  return execFileSync("tar", [...tarArgs, tarballPath, "package/package.json"], {
    cwd: workspaceRoot,
    encoding: "utf-8",
  });
}

describe.sequential("publish packaging", () => {
  it("rewrites workspace package versions for canary publishing", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "inkos-version-script-"));
    const tempPackagesDir = join(tempRoot, "packages");
    const tempCoreDir = join(tempPackagesDir, "core");
    const tempCliDir = join(tempPackagesDir, "cli");

    try {
      await mkdir(tempCoreDir, { recursive: true });
      await mkdir(tempCliDir, { recursive: true });

      await writeFile(
        join(tempRoot, "package.json"),
        `${JSON.stringify({ name: "inkos", version: "0.4.6" }, null, 2)}\n`,
      );
      await writeFile(
        join(tempCoreDir, "package.json"),
        `${JSON.stringify({ name: "@actalk/inkos-core", version: "0.4.6" }, null, 2)}\n`,
      );
      await writeFile(
        join(tempCliDir, "package.json"),
        `${JSON.stringify(
          {
            name: "@actalk/inkos",
            version: "0.4.6",
            dependencies: {
              "@actalk/inkos-core": "workspace:*",
              commander: "^13.0.0",
            },
          },
          null,
          2,
        )}\n`,
      );

      execFileSync(
        "node",
        [resolve(workspaceRoot, "scripts/set-package-versions.mjs"), "0.4.8-canary.7", "--root", tempRoot],
        {
          cwd: workspaceRoot,
          env: process.env,
          encoding: "utf-8",
        },
      );

      const rootPackageJson = JSON.parse(await readFile(join(tempRoot, "package.json"), "utf-8"));
      const corePackageJson = JSON.parse(await readFile(join(tempCoreDir, "package.json"), "utf-8"));
      const cliPackageJson = JSON.parse(await readFile(join(tempCliDir, "package.json"), "utf-8"));

      expect(rootPackageJson.version).toBe("0.4.8-canary.7");
      expect(corePackageJson.version).toBe("0.4.8-canary.7");
      expect(cliPackageJson.version).toBe("0.4.8-canary.7");
      expect(cliPackageJson.dependencies["@actalk/inkos-core"]).toBe("0.4.8-canary.7");
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses workspace protocol for internal dependencies in source manifests", async () => {
    const cliPackageJson = await sourceCliPackageJsonPromise;
    const studioPackageJson = await sourceStudioPackageJsonPromise;
    const corePackageJson = JSON.parse(
      await readFile(resolve(workspaceRoot, "packages/core/package.json"), "utf-8"),
    );

    // Internal deps must use workspace:* so local development links the
    // workspace sources; plain semver specs are fetched from the registry and
    // can silently resolve to a stale published build. The prepack hook
    // rewrites them to real versions for publishable tarballs.
    expect(cliPackageJson.dependencies["@actalk/inkos-core"]).toBe("workspace:*");
    expect(cliPackageJson.dependencies["@actalk/inkos-studio"]).toBe("workspace:*");
    expect(studioPackageJson.dependencies["@actalk/inkos-core"]).toBe("workspace:*");
    expect(studioPackageJson.dependencies["@hono/node-server"]).toBe("2.0.12");
    expect(corePackageJson.dependencies["@mariozechner/pi-agent-core"]).toBe("0.67.1");
    expect(corePackageJson.dependencies["@mariozechner/pi-ai"]).toBe("0.67.1");
    expect(corePackageJson.dependencies.jszip).toBe("3.10.1");
    expect(corePackageJson.dependencies["epub-gen-memory"]).toBeUndefined();
    expect(cliPackageJson.dependencies["epub-gen-memory"]).toBeUndefined();
  });

  it("verifies publishable manifests before npm publish runs", async () => {
    const cliPackageJson = await sourceCliPackageJsonPromise;
    const corePackageJson = JSON.parse(
      await readFile(resolve(workspaceRoot, "packages/core/package.json"), "utf-8"),
    );

    expect(cliPackageJson.scripts.prepublishOnly).toBe(
      "node ../../scripts/verify-no-workspace-protocol.mjs .",
    );
    expect(corePackageJson.scripts.prepublishOnly).toBe(
      "node ../../scripts/verify-no-workspace-protocol.mjs .",
    );
  });

  it("rejects workspace protocol pointing outside the workspace", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "inkos-publish-verify-pass-"));
    const tempPackagesDir = join(tempRoot, "packages");
    const tempCoreDir = join(tempPackagesDir, "core");
    const tempCliDir = join(tempPackagesDir, "cli");

    try {
      await mkdir(tempCoreDir, { recursive: true });
      await mkdir(tempCliDir, { recursive: true });

      await writeFile(
        join(tempRoot, "package.json"),
        `${JSON.stringify({ name: "inkos", version: "0.5.1" }, null, 2)}\n`,
      );
      await writeFile(
        join(tempCoreDir, "package.json"),
        `${JSON.stringify({ name: "@actalk/inkos-core", version: "0.5.1" }, null, 2)}\n`,
      );
      await writeFile(
        join(tempCliDir, "package.json"),
        `${JSON.stringify(
          {
            name: "@actalk/inkos",
            version: "0.5.1",
            dependencies: {
              // internal workspace:* is allowed — prepack rewrites it
              "@actalk/inkos-core": "workspace:*",
              // workspace: refs outside the workspace are unresolvable
              "left-pad": "workspace:*",
              commander: "^13.0.0",
            },
          },
          null,
          2,
        )}\n`,
      );

      expect(() =>
        execFileSync(
          "node",
          [resolve(workspaceRoot, "scripts/verify-no-workspace-protocol.mjs"), "packages/core", "packages/cli"],
          {
            cwd: tempRoot,
            env: process.env,
            encoding: "utf-8",
            stdio: "pipe",
          },
        )).toThrow(/workspace protocol is not allowed/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects workspace protocol manifests that normalize to the wrong internal version", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "inkos-publish-verify-fail-"));
    const tempPackagesDir = join(tempRoot, "packages");
    const tempCoreDir = join(tempPackagesDir, "core");
    const tempCliDir = join(tempPackagesDir, "cli");

    try {
      await mkdir(tempCoreDir, { recursive: true });
      await mkdir(tempCliDir, { recursive: true });

      await writeFile(
        join(tempRoot, "package.json"),
        `${JSON.stringify({ name: "inkos", version: "0.5.1" }, null, 2)}\n`,
      );
      await writeFile(
        join(tempCoreDir, "package.json"),
        `${JSON.stringify({ name: "@actalk/inkos-core", version: "0.5.1" }, null, 2)}\n`,
      );
      await writeFile(
        join(tempCliDir, "package.json"),
        `${JSON.stringify(
          {
            name: "@actalk/inkos",
            version: "0.5.1",
            dependencies: {
              "@actalk/inkos-core": "workspace:0.5.0",
            },
          },
          null,
          2,
        )}\n`,
      );

      expect(() =>
        execFileSync(
          "node",
          [resolve(workspaceRoot, "scripts/verify-no-workspace-protocol.mjs"), "packages/cli"],
          {
            cwd: tempRoot,
            env: process.env,
            encoding: "utf-8",
            stdio: "pipe",
          },
        )).toThrow(/workspace protocol is not allowed/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("replaces workspace dependencies before npm pack", { timeout: CLI_PACK_TEST_TIMEOUT_MS }, async () => {
    const packDir = await mkdtemp(join(tmpdir(), "inkos-cli-pack-"));

    try {
      const packedPackageJson = JSON.parse(await extractPackedPackageJson(cliDir, packDir));
      const corePackageJson = JSON.parse(
        await readFile(resolve(workspaceRoot, "packages/core/package.json"), "utf-8"),
      );
      const studioPackageJson = await sourceStudioPackageJsonPromise;

      expect(packedPackageJson.dependencies["@actalk/inkos-core"]).toBe(corePackageJson.version);
      expect(packedPackageJson.dependencies["@actalk/inkos-studio"]).toBe(studioPackageJson.version);
    } finally {
      await rm(packDir, { recursive: true, force: true });
    }
  });

  it("excludes compiled tests from the CLI tarball", { timeout: CLI_PACK_TEST_TIMEOUT_MS }, async () => {
    const packDir = await mkdtemp(join(tmpdir(), "inkos-cli-pack-tests-"));

    try {
      const tarballPath = await packPackage(cliDir, packDir);
      const tarArgs = [...tarForceLocalArgs(), "-tf"];
      const archiveListing = execFileSync("tar", [...tarArgs, tarballPath], {
        cwd: workspaceRoot,
        encoding: "utf-8",
      });

      expect(archiveListing).not.toContain("/__tests__/");
      expect(archiveListing).not.toMatch(/\.test\.(?:d\.ts|js)(?:\.map)?$/m);
    } finally {
      await rm(packDir, { recursive: true, force: true });
    }
  });

  it("packs the studio runtime entry alongside the built frontend", { timeout: STUDIO_PACK_TEST_TIMEOUT_MS }, async () => {
    const packDir = await mkdtemp(join(tmpdir(), "inkos-studio-pack-"));
    const packageDir = join(packDir, "studio-package");

    try {
      const studioPackageJson = await sourceStudioPackageJsonPromise;
      await mkdir(join(packageDir, "dist", "api"), { recursive: true });
      await writeFile(
        join(packageDir, "package.json"),
        `${JSON.stringify({
          ...studioPackageJson,
          scripts: {
            ...studioPackageJson.scripts,
            prepack: "node ../../scripts/prepare-package-for-publish.mjs",
            postpack: "node ../../scripts/restore-package-json.mjs",
          },
        }, null, 2)}\n`,
        "utf-8",
      );
      await writeFile(join(packageDir, "dist", "index.html"), "<!doctype html><div id=\"root\"></div>\n", "utf-8");
      await writeFile(join(packageDir, "dist", "api", "index.js"), "export {};\n", "utf-8");

      const tarballPath = await packPackage(packageDir, packDir, { ignoreScripts: true });
      const tarArgs = [...tarForceLocalArgs(), "-tf"];
      const archiveListing = execFileSync("tar", [...tarArgs, tarballPath], {
        cwd: workspaceRoot,
        encoding: "utf-8",
      });

      expect(archiveListing).toContain("package/dist/index.html");
      expect(archiveListing).toContain("package/dist/api/index.js");
    } finally {
      await rm(packDir, { recursive: true, force: true });
    }
  });
});
