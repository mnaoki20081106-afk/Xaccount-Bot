import type { Env } from "./types";
import { handleIntegratedSecurityRequest } from "./security/service";

function normalizeSecurityApiBaseUrl(raw?: string): string | null {
  let value = raw?.trim() ?? "";
  if (!value) return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/^SECURITY_API_BASE_URL\s*=\s*/i, "").trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    value = "https://" + value;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname) return null;
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "") + "/";
    return url.toString();
  } catch {
    return null;
  }
}

function localSecurityConfigured(env: Env): boolean {
  return Boolean(
    env.SECURITY_GATEWAY &&
    env.DISCORD_BOT_TOKEN?.trim() &&
    env.DISCORD_APPLICATION_ID?.trim()
  );
}

function legacySecurityConfigured(env: Env): boolean {
  return Boolean(
    normalizeSecurityApiBaseUrl(env.SECURITY_API_BASE_URL) &&
    env.SECURITY_BRIDGE_SECRET?.trim() &&
    env.SECURITY_BRIDGE_SECRET.trim().length >= 32
  );
}

export function securityBridgeConfigured(env: Env): boolean {
  return localSecurityConfigured(env) || legacySecurityConfigured(env);
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map(value => value.toString(16).padStart(2, "0"))
    .join("");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  ));
}

export async function securityBridgeFetch(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const method = String(init.method ?? "GET").toUpperCase();

  if (localSecurityConfigured(env)) {
    const url = new URL(
      path.replace(/^\//, ""),
      "https://integrated-security.internal/"
    );
    const request = new Request(url.toString(), {
      ...init,
      method,
      body: method === "GET" || method === "HEAD" ? undefined : init.body,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {})
      }
    });
    return handleIntegratedSecurityRequest(request, env);
  }

  if (!legacySecurityConfigured(env)) {
    throw new Error("Integrated Security is not configured");
  }

  const base = normalizeSecurityApiBaseUrl(env.SECURITY_API_BASE_URL);
  if (!base) throw new Error("SECURITY_API_BASE_URL is invalid");

  const url = new URL(path.replace(/^\//, ""), base);
  const body =
    typeof init.body === "string"
      ? init.body
      : init.body == null
        ? ""
        : String(init.body);
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const canonical =
    timestamp + "\n" +
    nonce + "\n" +
    method + "\n" +
    url.pathname + url.search + "\n" +
    body;
  const signature = await hmacHex(env.SECURITY_BRIDGE_SECRET!, canonical);
  const request = new Request(url.toString(), {
    ...init,
    method,
    body: body || undefined,
    headers: {
      "Content-Type": "application/json",
      "X-Security-Timestamp": timestamp,
      "X-Security-Nonce": nonce,
      "X-Security-Signature": signature,
      ...(init.headers ?? {})
    }
  });
  if (env.SECURITY_SERVICE) return env.SECURITY_SERVICE.fetch(request);
  return fetch(request);
}

export async function securityBridgeJson<T>(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await securityBridgeFetch(env, path, init);
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? text;
    } catch {
      // keep raw text
    }
    throw new Error(
      (localSecurityConfigured(env) ? "Integrated Security API " : "Security Bot API ") +
      response.status + ": " + message.slice(0, 300)
    );
  }
  return text ? JSON.parse(text) as T : undefined as T;
}

export async function openSecurityMaintenanceLease(
  env: Env,
  guildId: string,
  scope: "dashboard_edit" | "restore",
  seconds: number
): Promise<{ id: string; expiresAt: number } | null> {
  if (!securityBridgeConfigured(env)) return null;
  return securityBridgeJson(env, "/internal/guilds/" + guildId + "/maintenance", {
    method: "POST",
    body: JSON.stringify({
      actorId: env.DISCORD_APPLICATION_ID,
      scope,
      seconds
    })
  });
}
