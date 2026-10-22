import type { Env } from "./types";
import { randomId, json } from "./utils";
import { signedGeneratorFetch, generatorJson, popGeneratorAccounts } from "./generator-client";
import { handleGeneratorRestockApi } from "./generator-restock";
import { VendingHttpError } from "./vending";

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

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

      const items = await popGeneratorAccounts(env, count, { minWarmupDays, allowSoftShadow });

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
        popped: items.length,
        added: (pushPayload as Record<string, unknown>)?.added ?? items.length,
        supplierId,
        sku
      });
    }

    if (suffix === "/restock-rules" || suffix.startsWith("/restock-rules/")) {
      return await handleGeneratorRestockApi(request, env, guildId, suffix.slice("/restock-rules".length));
    }

    return null;
  } catch (error) {
    if (error instanceof VendingHttpError) {
      return json(env, { error: error.message }, error.status);
    }
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
