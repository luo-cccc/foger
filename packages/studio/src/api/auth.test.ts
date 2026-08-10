import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  isLoopbackHostname,
  resolveStudioAccessPolicy,
  studioAccessMiddleware,
} from "./auth.js";

const token = "production-test-token-1234567890";

describe("Studio access policy", () => {
  it("keeps loopback access zero-config", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(resolveStudioAccessPolicy("127.0.0.1", 4567, {})).toBeUndefined();
  });

  it("refuses unauthenticated or plaintext remote binding", () => {
    expect(() => resolveStudioAccessPolicy("0.0.0.0", 4567, {})).toThrow(/AUTH_TOKEN/u);
    expect(() => resolveStudioAccessPolicy("0.0.0.0", 4567, {
      INKOS_STUDIO_AUTH_TOKEN: token,
    })).toThrow(/HTTPS_PROXY/u);
  });

  it("requires explicit HTTPS origins for remote binding", () => {
    expect(() => resolveStudioAccessPolicy("0.0.0.0", 4567, {
      INKOS_STUDIO_AUTH_TOKEN: token,
      INKOS_STUDIO_BEHIND_HTTPS_PROXY: "1",
    })).toThrow(/ALLOWED_ORIGINS/u);
    expect(() => resolveStudioAccessPolicy("0.0.0.0", 4567, {
      INKOS_STUDIO_AUTH_TOKEN: token,
      INKOS_STUDIO_BEHIND_HTTPS_PROXY: "1",
      INKOS_STUDIO_ALLOWED_ORIGINS: "http://studio.example.com",
    })).toThrow(/must use HTTPS/u);
  });

  it("accepts Basic and Bearer credentials and rejects cross-site mutations", async () => {
    const policy = resolveStudioAccessPolicy("0.0.0.0", 4567, {
      INKOS_STUDIO_AUTH_TOKEN: token,
      INKOS_STUDIO_BEHIND_HTTPS_PROXY: "1",
      INKOS_STUDIO_ALLOWED_ORIGINS: "https://studio.example.com",
    });
    expect(policy).toBeDefined();
    const app = new Hono();
    app.use("*", studioAccessMiddleware(policy!));
    app.get("/health", (c) => c.json({ ok: true }));
    app.post("/mutate", (c) => c.json({ ok: true }));

    expect((await app.request("http://localhost/health")).status).toBe(401);
    expect((await app.request("http://localhost/health", {
      headers: { Authorization: `Basic ${Buffer.from(`inkos:${token}`).toString("base64")}` },
    })).status).toBe(200);
    expect((await app.request("http://localhost/health", {
      headers: { Authorization: `Bearer ${token}` },
    })).status).toBe(200);
    expect((await app.request("http://localhost/mutate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://evil.example.com",
        "Sec-Fetch-Site": "cross-site",
      },
    })).status).toBe(403);
    expect((await app.request("http://localhost/mutate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "https://studio.example.com",
      },
    })).status).toBe(200);
    expect((await app.request("http://localhost/mutate", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Origin: "null",
      },
    })).status).toBe(403);
  });
});
