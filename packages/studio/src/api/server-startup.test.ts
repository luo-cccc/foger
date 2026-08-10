import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer } from "./server.js";

const authEnvNames = [
  "INKOS_STUDIO_AUTH_TOKEN",
  "INKOS_STUDIO_BEHIND_HTTPS_PROXY",
  "INKOS_STUDIO_ALLOWED_ORIGINS",
] as const;

describe("Studio remote startup", () => {
  let root = "";
  let previousEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "inkos-studio-startup-"));
    previousEnv = Object.fromEntries(authEnvNames.map((name) => [name, process.env[name]]));
    for (const name of authEnvNames) delete process.env[name];
    await writeFile(join(root, "inkos.json"), JSON.stringify({
      name: "studio-startup-test",
      version: "0.1.0",
      language: "en",
      llm: {
        provider: "openai",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "test-model",
      },
    }), "utf-8");
    await writeFile(join(root, ".env"), "", "utf-8");
  });

  afterEach(async () => {
    for (const name of authEnvNames) restoreEnv(name, previousEnv[name]);
    await rm(root, { recursive: true, force: true });
  });

  it("refuses a remote listener without authentication", async () => {
    await expect(startStudioServer(root, 0, { hostname: "0.0.0.0" }))
      .rejects.toThrow(/INKOS_STUDIO_AUTH_TOKEN/u);
  });

  it("starts a configured remote listener and enforces authentication", async () => {
    const token = "remote-startup-test-token-123456789";
    process.env.INKOS_STUDIO_AUTH_TOKEN = token;
    process.env.INKOS_STUDIO_BEHIND_HTTPS_PROXY = "1";
    process.env.INKOS_STUDIO_ALLOWED_ORIGINS = "https://studio.example.com";

    const server = await startStudioServer(root, 0, { hostname: "0.0.0.0" });
    try {
      if (!server.listening) {
        await new Promise<void>((resolveListening, rejectListening) => {
          server.once("listening", resolveListening);
          server.once("error", rejectListening);
        });
      }
      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).not.toBe("string");
      const port = typeof address === "object" && address ? address.port : 0;

      const unauthorized = await fetch(`http://127.0.0.1:${port}/api/v1/project`);
      expect(unauthorized.status).toBe(401);
      const authorized = await fetch(`http://127.0.0.1:${port}/api/v1/project`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(authorized.status).toBe(200);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        });
      }
    }
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
