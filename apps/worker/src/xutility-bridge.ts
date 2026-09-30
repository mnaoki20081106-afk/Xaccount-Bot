import type { Env } from "./types";
import { randomId } from "./utils";

function xUtilityBaseUrl(env: Env): URL {
  const raw = env.XUTILITY_API_BASE_URL?.trim() ?? "";
  if (!raw) throw new Error("XUTILITY_API_BASE_URL_NOT_CONFIGURED");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("XUTILITY_API_BASE_URL_INVALID");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("XUTILITY_API_BASE_URL_MUST_BE_HTTPS_ORIGIN");
  }

  return new URL(url.origin + "/");
}

async function sign(secret: string, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(canonical)
    )
  );
  return [...signature]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function signedFetch(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const secret = env.XUTILITY_BRIDGE_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error("XUTILITY_BRIDGE_SECRET_NOT_CONFIGURED");
  }

  const url = new URL(path.replace(/^\//, ""), xUtilityBaseUrl(env));
  const method = String(init.method ?? "GET").toUpperCase();
  const body = typeof init.body === "string" ? init.body : "";
  const timestamp = String(Date.now());
  const nonce = randomId();
  const canonical =
    timestamp +
    "\n" +
    nonce +
    "\n" +
    method +
    "\n" +
    url.pathname +
    url.search +
    "\n" +
    body;

  const headers = new Headers(init.headers);
  headers.set("X-XUtility-Timestamp", timestamp);
  headers.set("X-XUtility-Nonce", nonce);
  headers.set("X-XUtility-Signature", await sign(secret, canonical));
  if (body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
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

export async function postXUtilityPanel(
  env: Env,
  guildId: string,
  kind: "shadowban" | "2fa",
  channelId: string
): Promise<{ ok: true; messageId?: string }> {
  const response = await signedFetch(
    env,
    "/bridge/main/guilds/" + guildId + "/panels/" + kind,
    {
      method: "POST",
      body: JSON.stringify({ channelId })
    }
  );

  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    const code = String(payload?.error ?? "XUTILITY_BRIDGE_ERROR");
    const message = String(payload?.message ?? "").trim();
    throw new Error(
      code +
        (message ? ": " + message : "") +
        " (HTTP " +
        response.status +
        ")"
    );
  }

  return {
    ok: true,
    messageId:
      typeof payload?.messageId === "string" ? payload.messageId : undefined
  };
}


export async function getXUtilitySearchCredentialStatus(
  env: Env
): Promise<{ configured: boolean; updatedAt: number | null }> {
  const response = await signedFetch(
    env,
    "/bridge/main/search-credential",
    { method: "GET" }
  );
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(
      String(payload?.error ?? "XUTILITY_BRIDGE_ERROR") +
        " (HTTP " +
        response.status +
        ")"
    );
  }
  return {
    configured: Boolean(payload?.configured),
    updatedAt:
      typeof payload?.updatedAt === "number" ? payload.updatedAt : null
  };
}

export async function saveXUtilitySearchCredential(
  env: Env,
  input: { session: string; csrf: string }
): Promise<{ configured: true; updatedAt: number }> {
  const response = await signedFetch(
    env,
    "/bridge/main/search-credential",
    {
      method: "PUT",
      body: JSON.stringify(input)
    }
  );
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(
      String(payload?.error ?? "XUTILITY_BRIDGE_ERROR") +
        " (HTTP " +
        response.status +
        ")"
    );
  }
  return {
    configured: true,
    updatedAt: Number(payload?.updatedAt ?? Date.now())
  };
}

export async function clearXUtilitySearchCredential(
  env: Env
): Promise<{ configured: false; updatedAt: null }> {
  const response = await signedFetch(
    env,
    "/bridge/main/search-credential",
    { method: "DELETE" }
  );
  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(
      String(payload?.error ?? "XUTILITY_BRIDGE_ERROR") +
        " (HTTP " +
        response.status +
        ")"
    );
  }
  return { configured: false, updatedAt: null };
}
