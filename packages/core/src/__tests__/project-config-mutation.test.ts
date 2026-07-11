import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initializeProjectConfig, mutateProjectConfig } from "../utils/project-config-mutation.js";

describe("mutateProjectConfig", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("serializes concurrent read-modify-write operations without losing fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-project-config-"));
    roots.push(root);
    await writeFile(join(root, "inkos.json"), JSON.stringify({ counter: 0, fields: {} }), "utf-8");

    await Promise.all(Array.from({ length: 20 }, (_, index) => mutateProjectConfig(root, async (config) => {
      const counter = typeof config.counter === "number" ? config.counter : 0;
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      config.counter = counter + 1;
      config.fields = { ...(config.fields as Record<string, unknown>), [`field${index}`]: index };
    })));

    const saved = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as {
      counter: number;
      fields: Record<string, number>;
    };
    expect(saved.counter).toBe(20);
    expect(Object.keys(saved.fields)).toHaveLength(20);
    await expect(stat(join(root, ".inkos-project-config.lock"))).rejects.toThrow();
  });

  it("allows only one concurrent project config initializer", async () => {
    const root = await mkdtemp(join(tmpdir(), "inkos-project-config-init-"));
    roots.push(root);

    const results = await Promise.allSettled([
      initializeProjectConfig(root, { owner: "first" }),
      initializeProjectConfig(root, { owner: "second" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const saved = JSON.parse(await readFile(join(root, "inkos.json"), "utf-8")) as { owner: string };
    expect(["first", "second"]).toContain(saved.owner);
    await expect(stat(join(root, ".inkos-project-config.lock"))).rejects.toThrow();
  });
});
