import type { Env } from "./types";
import { randomId, json } from "./utils";

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

function generatorBaseUrl(env: Env): URL {
  const raw = (env as unknown as Record<string, unknown>)["GENERATOR_API_BASE_URL"];
  const str = typeof raw === "string" ? raw.trim() : "";
  if (!str) throw new Error("GENERATOR_API_BASE_URL_NOT_CONFIGURED");

  let url: URL;
  try {
    url = new URL(str);
  } catch {
    throw new Error("GENERATOR_API_BASE_URL_INVALID");
  }

  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new Error("GENERATOR_API_BASE_URL_MUST_BE_HTTPS_ORIGIN");
  }

  return new URL(url.origin + "/");
}

async function signGenerator(secret: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))
  );
  return [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function signedGeneratorFetch(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const rawSecret = (env as unknown as Record<string, unknown>)["GENERATOR_BRIDGE_SECRET"];
  const secret = typeof rawSecret === "string" ? rawSecret.trim() : "";
  if (secret.length < 32) throw new Error("GENERATOR_BRIDGE_SECRET_NOT_CONFIGURED");

  const base = generatorBaseUrl(env);
  const url = new URL(path.replace(/^\//, ""), base);
  const method = String(init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? init.body : "";
  const timestamp = String(Date.now());
  const nonce = randomId();
  const canonical =
    timestamp + "\n" +
    nonce + "\n" +
    method + "\n" +
    url.pathname + url.search + "\n" +
    body;

  const headers = new Headers(init.headers);
  headers.set("X-Generator-Timestamp", timestamp);
  headers.set("X-Generator-Nonce", nonce);
  headers.set("X-Generator-Signature", await signGenerator(secret, canonical));
  if (body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url.toString(), {
      ...init,
      method,
      body: body || undefined,
      headers,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function signedShiireFetch(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const rawBase = (env as unknown as Record<string, unknown>)["SHIIRE_API_BASE_URL"];
  const baseStr = typeof rawBase === "string" ? rawBase.trim() : "";
  if (!baseStr) throw new Error("SHIIRE_API_BASE_URL_NOT_CONFIGURED");

  const rawSecret = (env as unknown as Record<string, unknown>)["SHIIRE_BRIDGE_SECRET"];
  const secret = typeof rawSecret === "string" ? rawSecret.trim() : "";
  if (secret.length < 32) throw new Error("SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED");

  const base = new URL(baseStr);
  const url = new URL(path.replace(/^\//, ""), base.origin + "/");
  const method = String(init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? init.body : "";
  const timestamp = String(Date.now());
  const nonce = randomId();
  const canonical =
    timestamp + "\n" +
    nonce + "\n" +
    method + "\n" +
    url.pathname + url.search + "\n" +
    body;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))
  );
  const signature = [...sig].map(b => b.toString(16).padStart(2, "0")).join("");

  const headers = new Headers(init.headers);
  headers.set("X-Shiire-Timestamp", timestamp);
  headers.set("X-Shiire-Nonce", nonce);
  headers.set("X-Shiire-Signature", signature);
  if (body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url.toString(), {
      ...init,
      method,
      body: body || undefined,
      headers,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function generatorJson(response: Response): Promise<unknown> {
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const code = (payload as Record<string, unknown>)?.detail ?? response.status;
    throw new Error("GENERATOR_API_ERROR:" + code + " (HTTP " + response.status + ")");
  }
  return payload;
}

export async function handleGeneratorBridge(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  const guildMatch = url.pathname.match(
    /^\/api\/guilds\/(\d+)\/generator(\/.*)?$/
  );
  if (!guildMatch) return null;

  const guildId = guildMatch[1]!;
  const suffix = guildMatch[2] ?? "";

  try {
    if (suffix === "/status" && request.method === "GET") {
      const resp = await signedGeneratorFetch(env, "/api/generator/status", { method: "GET" });
      const data = await generatorJson(resp);
      return json(env, data);
    }

    if (suffix === "/inventory" && request.method === "GET") {
      const resp = await signedGeneratorFetch(env, "/api/generator/inventory", { method: "GET" });
      const data = await generatorJson(resp);
      return json(env, data);
    }

    if (suffix === "/accounts" && request.method === "GET") {
      const fwdUrl = new URL("/api/generator/accounts", "https://x");
      fwdUrl.search = url.search;
      const resp = await signedGeneratorFetch(env, fwdUrl.pathname + fwdUrl.search, { method: "GET" });
      const data = await generatorJson(resp);
      return json(env, data);
    }

    if (suffix === "/generate" && request.method === "POST") {
      const body = await request.text();
      const resp = await signedGeneratorFetch(env, "/api/generator/generate", {
        method: "POST",
        body
      });
      const data = await generatorJson(resp);
      return json(env, data);
    }

    if (suffix === "/config" && request.method === "GET") {
      const resp = await signedGeneratorFetch(env, "/api/generator/config", { method: "GET" });
      const data = await generatorJson(resp);
      return json(env, data);
    }

    if (suffix === "/push-to-shiire" && request.method === "POST") {
      const rawBody = await request.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        return json(env, { error: "INVALID_JSON" }, 400);
      }

      const count = Number(parsed.count ?? 1);
      const supplierId = String(parsed.supplierId ?? "").trim();
      const sku = String(parsed.sku ?? "").trim();
      const minWarmupDays = Number(parsed.minWarmupDays ?? 0);
      const allowSoftShadow = Boolean(parsed.allowSoftShadow ?? false);

      if (!supplierId || !sku || !Number.isInteger(count) || count < 1 || count > 200) {
        return json(env, { error: "INVALID_REQUEST" }, 400);
      }

      const popResp = await signedGeneratorFetch(env, "/api/generator/pop", {
        method: "POST",
        body: JSON.stringify({ count, min_warmup_days: minWarmupDays, allow_soft_shadow: allowSoftShadow })
      });
      const popData = await generatorJson(popResp) as {
        ok: boolean;
        popped: number;
        accounts: Array<{
          id: number;
          username: string;
          password: string;
          email: string | null;
          phone: string | null;
          auth_token: string | null;
          ct0: string | null;
          twofa_secret: string | null;
        }>;
      };

      const items = popData.accounts.map(a => {
        const parts = [a.username + ":" + a.password];
        if (a.email) parts.push(a.email);
        if (a.phone) parts.push(a.phone);
        if (a.auth_token) parts.push("auth_token=" + a.auth_token);
        if (a.ct0) parts.push("ct0=" + a.ct0);
        if (a.twofa_secret) parts.push("2fa=" + a.twofa_secret);
        return parts.join("|");
      });

      const pushResp = await signedShiireFetch(
        env,
        "/bridge/main/guilds/" + guildId + "/generator/push",
        {
          method: "POST",
          body: JSON.stringify({ supplierId, sku, items })
        }
      );
      const pushData = await pushResp.text();
      let pushPayload: unknown = null;
      try { pushPayload = pushData ? JSON.parse(pushData) : null; } catch {}
      if (!pushResp.ok) {
        const code = (pushPayload as Record<string, unknown>)?.error ?? "SHIIRE_PUSH_FAILED";
        return json(env, { error: String(code), status: pushResp.status }, 502);
      }

      return json(env, {
        ok: true,
        popped: popData.popped,
        added: (pushPayload as Record<string, unknown>)?.added ?? popData.popped,
        supplierId,
        sku
      });
    }

    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const status =
      msg.startsWith("GENERATOR_API_BASE_URL_NOT_CONFIGURED") ||
      msg.startsWith("GENERATOR_BRIDGE_SECRET_NOT_CONFIGURED") ||
      msg.startsWith("SHIIRE_API_BASE_URL_NOT_CONFIGURED") ||
      msg.startsWith("SHIIRE_BRIDGE_SECRET_NOT_CONFIGURED")
        ? 503
        : 502;
    return json(env, { error: msg }, status);
  }
}
