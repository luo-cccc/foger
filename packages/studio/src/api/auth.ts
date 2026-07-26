import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const MIN_AUTH_TOKEN_LENGTH = 24;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface StudioAccessPolicy {
  readonly token: string;
  readonly allowedOrigins: ReadonlySet<string>;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return normalized === "localhost"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

export function resolveStudioAccessPolicy(
  hostname: string,
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): StudioAccessPolicy | undefined {
  const token = env.INKOS_STUDIO_AUTH_TOKEN?.trim() ?? "";
  const loopback = isLoopbackHostname(hostname);

  if (!token && loopback) return undefined;
  if (!token) {
    throw new Error(
      "Remote Studio binding requires INKOS_STUDIO_AUTH_TOKEN. "
      + "Keep INKOS_STUDIO_HOST on loopback or configure authenticated HTTPS access.",
    );
  }
  if (token.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new Error(`INKOS_STUDIO_AUTH_TOKEN must contain at least ${MIN_AUTH_TOKEN_LENGTH} characters.`);
  }

  const configuredOrigins = parseAllowedOrigins(env.INKOS_STUDIO_ALLOWED_ORIGINS);
  if (!loopback) {
    if (env.INKOS_STUDIO_BEHIND_HTTPS_PROXY !== "1") {
      throw new Error(
        "Remote Studio binding requires INKOS_STUDIO_BEHIND_HTTPS_PROXY=1; "
        + "Basic/Bearer credentials must not cross a plaintext network connection.",
      );
    }
    if (configuredOrigins.size === 0) {
      throw new Error(
        "Remote Studio binding requires INKOS_STUDIO_ALLOWED_ORIGINS with at least one HTTPS origin.",
      );
    }
    for (const origin of configuredOrigins) {
      if (!origin.startsWith("https://")) {
        throw new Error(`Remote Studio allowed origin must use HTTPS: ${origin}`);
      }
    }
  } else {
    configuredOrigins.add(`http://localhost:${port}`);
    configuredOrigins.add(`http://127.0.0.1:${port}`);
    configuredOrigins.add(`http://[::1]:${port}`);
  }

  return { token, allowedOrigins: configuredOrigins };
}

export function studioAccessMiddleware(policy: StudioAccessPolicy): MiddlewareHandler {
  return async (c, next) => {
    if (!isAuthorized(c.req.header("Authorization"), policy.token)) {
      c.header("WWW-Authenticate", 'Basic realm="InkOS Studio", charset="UTF-8"');
      return c.json({ error: { code: "UNAUTHORIZED", message: "Studio authentication is required." } }, 401);
    }

    if (UNSAFE_METHODS.has(c.req.method.toUpperCase())) {
      const fetchSite = c.req.header("Sec-Fetch-Site")?.toLowerCase();
      const rawOrigin = c.req.header("Origin");
      let origin: string | undefined;
      try {
        origin = normalizeOrigin(rawOrigin);
      } catch {
        return c.json({ error: { code: "FORBIDDEN_ORIGIN", message: "Cross-site Studio mutation rejected." } }, 403);
      }
      if (fetchSite === "cross-site" || (origin && !policy.allowedOrigins.has(origin))) {
        return c.json({ error: { code: "FORBIDDEN_ORIGIN", message: "Cross-site Studio mutation rejected." } }, 403);
      }
    }

    await next();
  };
}

function isAuthorized(header: string | undefined, expectedToken: string): boolean {
  if (!header) return false;
  const [scheme, encoded] = header.trim().split(/\s+/, 2);
  if (!scheme || !encoded) return false;

  if (scheme.toLowerCase() === "bearer") {
    return constantTimeEqual(encoded, expectedToken);
  }
  if (scheme.toLowerCase() !== "basic") return false;

  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const separator = decoded.indexOf(":");
    if (separator < 0 || decoded.slice(0, separator) !== "inkos") return false;
    return constantTimeEqual(decoded.slice(separator + 1), expectedToken);
  } catch {
    return false;
  }
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf-8");
  const expectedBuffer = Buffer.from(expected, "utf-8");
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of raw?.split(",") ?? []) {
    const origin = normalizeOrigin(entry);
    if (!origin) continue;
    origins.add(origin);
  }
  return origins;
}

function normalizeOrigin(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error("origin must not include a path, credentials, query, or fragment");
    }
    return url.origin;
  } catch (error) {
    throw new Error(`Invalid Studio origin "${value}": ${error instanceof Error ? error.message : String(error)}`);
  }
}
