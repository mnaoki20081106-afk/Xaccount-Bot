import type { Env } from "./types";
import {
  claimCheatCommands,
  CHEAT_GAMES,
  ensureCheatGuild,
  finishCheatCommand,
  getCheatGuild,
  isSnowflake,
  saveCheatState,
  touchLastSeen
} from "./cheat-db";
import { json } from "./utils";

/**
 * Discord-Cheat(Python常駐Bot)は外部公開できない環境で動く前提のため、Xaccount-Botから
 * Botへ接続せず、Botの方が定期的にこのWorkerへ取りに来る(プル方式)。
 *
 *   POST /api/cheat-bridge/poll    heartbeat + 設定差分と依頼(パネル設置/テスト送信)の取得
 *   POST /api/cheat-bridge/report  参加サーバー/チャンネル/設置状況の報告
 *   POST /api/cheat-bridge/result  依頼の結果
 *
 * 認証: X-Cheat-Timestamp(ms) と X-Cheat-Signature =
 *   HMAC-SHA256(CHEAT_BRIDGE_SECRET, timestamp \n METHOD \n path+query \n body) の16進。
 * pollは同じ内容を再送されても副作用がない(依頼は配信済み印が付くだけ)ため、nonce表は持たず
 * 時刻窓(±5分)のみで守る。通信はHTTPS。
 */

const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_GUILDS_PER_REQUEST = 50;

function hexBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function signCheatRequest(
  secret: string,
  timestamp: string,
  method: string,
  target: string,
  body: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const canonical = timestamp + "\n" + method.toUpperCase() + "\n" + target + "\n" + body;
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verify(request: Request, env: Env, url: URL, body: string): Promise<void> {
  const secret = env.CHEAT_BRIDGE_SECRET?.trim() ?? "";
  if (secret.length < 32) throw new Error("CHEAT_BRIDGE_SECRET_NOT_CONFIGURED");
  const timestamp = request.headers.get("X-Cheat-Timestamp")?.trim() ?? "";
  const signature = request.headers.get("X-Cheat-Signature")?.trim() ?? "";
  const ts = Number(timestamp);
  if (!/^\d{10,16}$/.test(timestamp) || !Number.isFinite(ts)) throw new Error("INVALID_TIMESTAMP");
  if (Math.abs(Date.now() - ts) > MAX_CLOCK_SKEW_MS) throw new Error("STALE_TIMESTAMP");
  const sig = hexBytes(signature);
  if (!sig) throw new Error("INVALID_SIGNATURE");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const canonical = timestamp + "\n" + request.method.toUpperCase() + "\n" + url.pathname + url.search + "\n" + body;
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sig.buffer as ArrayBuffer,
    new TextEncoder().encode(canonical)
  );
  if (!ok) throw new Error("INVALID_SIGNATURE");
}

function parseBody(body: string): Record<string, any> {
  try {
    const value = JSON.parse(body);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    // fallthrough
  }
  throw new Error("INVALID_JSON");
}

function guildIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isSnowflake))].slice(0, MAX_GUILDS_PER_REQUEST);
}

export async function handleCheatServiceBridge(
  request: Request,
  env: Env,
  url: URL
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/cheat-bridge/")) return null;
  if (request.method !== "POST") return json(env, { error: "METHOD_NOT_ALLOWED" }, 405);

  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json(env, { error: "BODY_TOO_LARGE" }, 413);

  try {
    await verify(request, env, url, body);
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNAUTHORIZED";
    return json(env, { error: code }, code === "CHEAT_BRIDGE_SECRET_NOT_CONFIGURED" ? 503 : 401);
  }

  try {
    const input = parseBody(body);

    if (url.pathname === "/api/cheat-bridge/poll") {
      const ids = guildIdList(input.guilds);
      const revs = input.revs && typeof input.revs === "object" ? (input.revs as Record<string, unknown>) : {};
      await touchLastSeen(env);

      const configs: Record<string, { rev: number; config: unknown }> = {};
      const needReport: string[] = [];
      for (const id of ids) {
        const guild = (await getCheatGuild(env, id)) ?? (await ensureCheatGuild(env, id));
        if (revs[id] !== guild.rev) configs[id] = { rev: guild.rev, config: guild.config };
        if (!guild.state) needReport.push(id);
      }
      const commands = (await claimCheatCommands(env, ids)).map((c) => ({
        id: c.id,
        guildId: c.guildId,
        kind: c.kind,
        payload: c.payload
      }));
      return json(env, { ok: true, configs, commands, needReport });
    }

    if (url.pathname === "/api/cheat-bridge/report") {
      const guilds = Array.isArray(input.guilds) ? input.guilds.slice(0, MAX_GUILDS_PER_REQUEST) : [];
      let saved = 0;
      for (const g of guilds) {
        if (!g || !isSnowflake(g.id)) continue;
        await saveCheatState(env, g.id, g.state);
        saved++;
      }
      await touchLastSeen(env);
      return json(env, { ok: true, saved });
    }

    if (url.pathname === "/api/cheat-bridge/result") {
      const id = typeof input.id === "string" ? input.id : "";
      if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) return json(env, { error: "INVALID_COMMAND_ID" }, 400);
      const result = input.result && typeof input.result === "object" ? input.result : {};
      const updated = await finishCheatCommand(env, id, input.ok === true, result);
      return json(env, { ok: true, updated });
    }

    return json(env, { error: "NOT_FOUND" }, 404);
  } catch (error) {
    const code = error instanceof Error ? error.message : String(error);
    if (code === "INVALID_JSON") return json(env, { error: code }, 400);
    console.error("cheat bridge failed", code);
    return json(env, { error: "CHEAT_BRIDGE_INTERNAL_ERROR" }, 500);
  }
}

export { CHEAT_GAMES };
