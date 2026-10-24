import type { Env } from "./types";
import { randomId } from "./utils";

// Low-level HTTP client for the X-Account Generator bridge. Kept separate from
// generator-bridge.ts (the dashboard-facing route handler) so that other
// callers — the automatic restock sweep in generator-restock.ts, in
// particular — can pop accounts from the generator without importing the
// route handler module (and risking a circular import between the two).

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

export async function signedGeneratorFetch(
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

export async function generatorJson(response: Response): Promise<unknown> {
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const code = (payload as Record<string, unknown>)?.detail ?? response.status;
    throw new Error("GENERATOR_API_ERROR:" + code + " (HTTP " + response.status + ")");
  }
  return payload;
}

type GeneratorAccount = {
  id: number;
  username: string;
  password: string;
  email: string | null;
  email_password?: string | null;
  email_token?: string | null;
  email_token_verification?: string | null;
  phone: string | null;
  auth_token: string | null;
  ct0: string | null;
  twofa_secret: string | null;
};

// Account Format: Username:Password:Email:Email Password:Email Token:Email Token Verification:Phone:2FA:Token
// Missing values stay empty so field positions never shift.
function formatGeneratorAccountLine(a: GeneratorAccount): string {
  return [
    a.username,
    a.password,
    a.email,
    a.email_password,
    a.email_token,
    a.email_token_verification,
    a.phone,
    a.twofa_secret,
    a.auth_token
  ].map(v => v ?? "").join(":");
}

// Pops up to `count` ready accounts from the generator and formats each as a
// single stock-content line ("Username:Password:Email:EmailPassword:EmailToken:EmailTokenVerification:Phone:2FA:Token"),
// the same format used for manual "push to shiire" pushes and pasted/imported
// vending stock. Shared by the one-off push action and the automatic restock sweep.
export async function popGeneratorAccounts(
  env: Env,
  count: number,
  opts: { minWarmupDays?: number; allowSoftShadow?: boolean; tier?: "any" | "top_search" } = {}
): Promise<string[]> {
  const resp = await signedGeneratorFetch(env, "/api/generator/pop", {
    method: "POST",
    body: JSON.stringify({
      count,
      min_warmup_days: opts.minWarmupDays ?? 0,
      allow_soft_shadow: opts.allowSoftShadow ?? false,
      // top_search: 検索TOP掲載を実測済み（卒業テスト合格）の垢だけ
      tier: opts.tier ?? "any"
    })
  });
  const data = (await generatorJson(resp)) as { ok: boolean; popped: number; accounts: GeneratorAccount[] };
  return data.accounts.map(formatGeneratorAccountLine);
}
