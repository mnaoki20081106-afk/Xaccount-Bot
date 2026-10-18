import type { Env } from "./types";
import { randomId } from "./utils";

export type CheatGame = "nyanko" | "tsum" | "puni";

export const CHEAT_GAMES: readonly CheatGame[] = ["nyanko", "tsum", "puni"];

export class CheatBridgeError extends Error {
  status: number;
  code: string;
  detail: string;

  constructor(status: number, code: string, detail = "") {
    super(code + (detail ? ": " + detail : "") + " (HTTP " + status + ")");
    this.name = "CheatBridgeError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function cheatBaseUrl(env: Env): URL {
  const raw = env.CHEAT_API_BASE_URL?.trim() ?? "";
  if (!raw) throw new Error("CHEAT_API_BASE_URL_NOT_CONFIGURED");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CHEAT_API_BASE_URL_INVALID");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("CHEAT_API_BASE_URL_MUST_BE_HTTPS_ORIGIN");
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
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))
  );
  return [...signature]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

// Discord-Cheat の hub/api.py と同じ canonical:
// timestamp \n nonce \n METHOD \n path+query \n body
async function cheatRequest<T>(
  env: Env,
  path: string,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const secret = env.CHEAT_BRIDGE_SECRET?.trim() ?? "";
  if (secret.length < 32) throw new Error("CHEAT_BRIDGE_SECRET_NOT_CONFIGURED");

  const url = new URL(path.replace(/^\//, ""), cheatBaseUrl(env));
  const method = String(init.method ?? "GET").toUpperCase();
  const body = init.body === undefined ? "" : JSON.stringify(init.body);
  const timestamp = String(Date.now());
  const nonce = randomId();
  const canonical =
    timestamp + "\n" + nonce + "\n" + method + "\n" + url.pathname + url.search + "\n" + body;

  const headers = new Headers();
  headers.set("X-Cheat-Timestamp", timestamp);
  headers.set("X-Cheat-Nonce", nonce);
  headers.set("X-Cheat-Signature", await sign(secret, canonical));
  if (body) headers.set("Content-Type", "application/json");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method,
      body: body || undefined,
      headers,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let payload: any = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new CheatBridgeError(
      response.status,
      String(payload?.error ?? "CHEAT_BRIDGE_ERROR"),
      String(payload?.message ?? "").trim()
    );
  }
  return payload as T;
}

export type CheatPanelState = {
  channelId: string | null;
  color: number | null;
  messageId: string | null;
  deployedChannelId: string | null;
  deployedAt: number | null;
};

export type CheatGameAchievement = { enabled: boolean; channelId: string | null };

export type CheatAchievements = {
  enabled: boolean;
  channelId: string | null;
  color: number;
  showAmount: boolean;
  showUser: boolean;
  games: Record<CheatGame, CheatGameAchievement>;
  counters: Record<CheatGame, number>;
};

export type CheatConfig = {
  guildId: string;
  guildName: string;
  games: { key: CheatGame; label: string; panelName: string; defaultColor: number }[];
  panels: Record<CheatGame, CheatPanelState>;
  achievements: CheatAchievements;
  channels: { id: string; name: string; canPost: boolean }[];
};

export type CheatConfigPatch = {
  panels?: Partial<Record<CheatGame, { channelId?: string | null; color?: number | null }>>;
  achievements?: {
    enabled?: boolean;
    channelId?: string | null;
    color?: number;
    showAmount?: boolean;
    showUser?: boolean;
    games?: Partial<Record<CheatGame, { enabled?: boolean; channelId?: string | null }>>;
  };
};

export function getCheatConfig(env: Env, guildId: string): Promise<CheatConfig> {
  return cheatRequest(env, "/bridge/main/guilds/" + guildId + "/config");
}

export function putCheatConfig(
  env: Env,
  guildId: string,
  patch: CheatConfigPatch
): Promise<CheatConfig> {
  return cheatRequest(env, "/bridge/main/guilds/" + guildId + "/config", {
    method: "PUT",
    body: patch
  });
}

export function deployCheatPanel(
  env: Env,
  guildId: string,
  game: CheatGame,
  input: { channelId: string; color?: number | null }
): Promise<{ ok: true; game: CheatGame; channelId: string; messageId: string; updated: boolean }> {
  const body: { channelId: string; color?: number | null } = { channelId: input.channelId };
  if (input.color !== undefined) body.color = input.color;
  return cheatRequest(env, "/bridge/main/guilds/" + guildId + "/panels/" + game, {
    method: "POST",
    body
  });
}

export function testCheatAchievement(
  env: Env,
  guildId: string,
  game: CheatGame
): Promise<{ ok: true; channelId: string }> {
  return cheatRequest(env, "/bridge/main/guilds/" + guildId + "/achievements/test", {
    method: "POST",
    body: { game }
  });
}
