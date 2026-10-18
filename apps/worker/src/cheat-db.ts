import type { Env } from "./types";
import { randomId } from "./utils";

export type CheatGame = "nyanko" | "tsum" | "puni";

export const CHEAT_GAME_META: readonly {
  key: CheatGame;
  label: string;
  panelName: string;
  defaultColor: number;
}[] = [
  { key: "nyanko", label: "にゃんこ大戦争", panelName: "にゃんこ大戦争パネル", defaultColor: 0x2b2d31 },
  { key: "tsum", label: "ツムツム", panelName: "ツムツムパネル", defaultColor: 0x06c755 },
  { key: "puni", label: "ぷにぷに", panelName: "ぷにぷにパネル", defaultColor: 0x5865f2 }
];

export const CHEAT_GAMES: readonly CheatGame[] = ["nyanko", "tsum", "puni"];

export const DEFAULT_ACHIEVEMENT_COLOR = 5763719; // Discord-Shiireの購入完了ログと同じ緑

export const ONLINE_WINDOW_MS = 60_000;
const COMMAND_RECLAIM_MS = 60_000;
const COMMAND_KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_PER_GUILD = 20;

export class CheatInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheatInputError";
  }
}

export type CheatPanelConfig = { channelId: string | null; color: number | null };
export type CheatGameAchievement = { enabled: boolean; channelId: string | null };
export type CheatAchievementConfig = {
  enabled: boolean;
  channelId: string | null;
  color: number;
  showAmount: boolean;
  showUser: boolean;
  games: Record<CheatGame, CheatGameAchievement>;
};
export type CheatConfig = {
  panels: Record<CheatGame, CheatPanelConfig>;
  achievements: CheatAchievementConfig;
};

export type CheatChannel = { id: string; name: string; canPost: boolean };
export type CheatPanelState = {
  messageId: string | null;
  deployedChannelId: string | null;
  deployedAt: number | null;
};
export type CheatGuildState = {
  guildName: string;
  channels: CheatChannel[];
  panels: Record<CheatGame, CheatPanelState>;
  counters: Record<CheatGame, number>;
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

export type CheatCommandKind = "deploy_panel" | "test_achievement";
export type CheatCommandStatus = "pending" | "running" | "done" | "failed";
export type CheatCommand = {
  id: string;
  guildId: string;
  kind: CheatCommandKind;
  payload: Record<string, unknown>;
  status: CheatCommandStatus;
  result: Record<string, unknown> | null;
  createdAt: number;
  finishedAt: number | null;
};

const SNOWFLAKE = /^\d{15,25}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

export function isColor(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffff;
}

export function defaultConfig(): CheatConfig {
  const panels = {} as Record<CheatGame, CheatPanelConfig>;
  const games = {} as Record<CheatGame, CheatGameAchievement>;
  for (const key of CHEAT_GAMES) {
    panels[key] = { channelId: null, color: null };
    games[key] = { enabled: true, channelId: null };
  }
  return {
    panels,
    achievements: {
      enabled: true,
      channelId: null,
      color: DEFAULT_ACHIEVEMENT_COLOR,
      showAmount: true,
      showUser: true,
      games
    }
  };
}

export function defaultState(): CheatGuildState {
  const panels = {} as Record<CheatGame, CheatPanelState>;
  const counters = {} as Record<CheatGame, number>;
  for (const key of CHEAT_GAMES) {
    panels[key] = { messageId: null, deployedChannelId: null, deployedAt: null };
    counters[key] = 0;
  }
  return { guildName: "", channels: [], panels, counters };
}

/** 保存値を既定値の上に重ねる(キーが増えた更新後も古い行が読める)。 */
function mergeConfig(saved: any): CheatConfig {
  const out = defaultConfig();
  if (!saved || typeof saved !== "object") return out;
  for (const key of CHEAT_GAMES) {
    const p = saved.panels?.[key];
    if (p) {
      if (p.channelId === null || isSnowflake(p.channelId)) out.panels[key].channelId = p.channelId;
      if (p.color === null || isColor(p.color)) out.panels[key].color = p.color;
    }
    const g = saved.achievements?.games?.[key];
    if (g) {
      if (typeof g.enabled === "boolean") out.achievements.games[key].enabled = g.enabled;
      if (g.channelId === null || isSnowflake(g.channelId)) out.achievements.games[key].channelId = g.channelId;
    }
  }
  const a = saved.achievements;
  if (a) {
    for (const flag of ["enabled", "showAmount", "showUser"] as const) {
      if (typeof a[flag] === "boolean") out.achievements[flag] = a[flag];
    }
    if (a.channelId === null || isSnowflake(a.channelId)) out.achievements.channelId = a.channelId;
    if (isColor(a.color)) out.achievements.color = a.color;
  }
  return out;
}

function mergeState(saved: any): CheatGuildState {
  const out = defaultState();
  if (!saved || typeof saved !== "object") return out;
  if (typeof saved.guildName === "string") out.guildName = saved.guildName.slice(0, 100);
  if (Array.isArray(saved.channels)) {
    out.channels = saved.channels
      .filter((c: any) => c && isSnowflake(c.id) && typeof c.name === "string")
      .slice(0, 500)
      .map((c: any) => ({ id: c.id, name: String(c.name).slice(0, 100), canPost: c.canPost === true }));
  }
  for (const key of CHEAT_GAMES) {
    const p = saved.panels?.[key];
    if (p) {
      out.panels[key] = {
        messageId: isSnowflake(p.messageId) ? p.messageId : null,
        deployedChannelId: isSnowflake(p.deployedChannelId) ? p.deployedChannelId : null,
        deployedAt: Number.isSafeInteger(p.deployedAt) ? p.deployedAt : null
      };
    }
    const n = saved.counters?.[key];
    if (Number.isSafeInteger(n) && n >= 0) out.counters[key] = n;
  }
  return out;
}

/** 管理画面からの部分更新を検証して適用する。不正なら何も保存しない。 */
export function applyPatch(current: CheatConfig, patch: unknown): CheatConfig {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new CheatInputError("JSON objectが必要です");
  }
  const input = patch as CheatConfigPatch;
  const next = mergeConfig(JSON.parse(JSON.stringify(current)));

  if (input.panels !== undefined) {
    if (!input.panels || typeof input.panels !== "object") throw new CheatInputError("panelsが不正です");
    for (const [game, p] of Object.entries(input.panels)) {
      if (!(CHEAT_GAMES as readonly string[]).includes(game)) continue;
      if (!p || typeof p !== "object") throw new CheatInputError("panelsが不正です");
      const target = next.panels[game as CheatGame];
      if ("channelId" in p) {
        if (p.channelId !== null && !isSnowflake(p.channelId)) throw new CheatInputError("チャンネルIDの形式が不正です");
        target.channelId = p.channelId ?? null;
      }
      if ("color" in p) {
        if (p.color !== null && !isColor(p.color)) throw new CheatInputError("色は0〜16777215の整数です");
        target.color = p.color ?? null;
      }
    }
  }

  const ach = input.achievements;
  if (ach !== undefined) {
    if (!ach || typeof ach !== "object") throw new CheatInputError("achievementsが不正です");
    const a = next.achievements;
    for (const flag of ["enabled", "showAmount", "showUser"] as const) {
      if (flag in ach) {
        if (typeof ach[flag] !== "boolean") throw new CheatInputError(flag + "はtrue/falseです");
        a[flag] = ach[flag] as boolean;
      }
    }
    if ("channelId" in ach) {
      if (ach.channelId !== null && !isSnowflake(ach.channelId)) throw new CheatInputError("実績チャンネルIDの形式が不正です");
      a.channelId = ach.channelId ?? null;
    }
    if ("color" in ach) {
      if (!isColor(ach.color)) throw new CheatInputError("色は0〜16777215の整数です");
      a.color = ach.color;
    }
    if (ach.games !== undefined) {
      if (!ach.games || typeof ach.games !== "object") throw new CheatInputError("gamesが不正です");
      for (const [game, g] of Object.entries(ach.games)) {
        if (!(CHEAT_GAMES as readonly string[]).includes(game)) continue;
        if (!g || typeof g !== "object") throw new CheatInputError("gamesが不正です");
        const target = a.games[game as CheatGame];
        if ("enabled" in g) {
          if (typeof g.enabled !== "boolean") throw new CheatInputError("enabledはtrue/falseです");
          target.enabled = g.enabled;
        }
        if ("channelId" in g) {
          if (g.channelId !== null && !isSnowflake(g.channelId)) throw new CheatInputError("チャンネルIDの形式が不正です");
          target.channelId = g.channelId ?? null;
        }
      }
    }
  }
  return next;
}

const schemaReady = new WeakMap<object, Promise<void>>();

export async function ensureCheatSchema(env: Env): Promise<void> {
  let ready = schemaReady.get(env.DB);
  if (!ready) {
    ready = env.DB.batch([
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS cheat_guild (guild_id TEXT PRIMARY KEY, config TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 1, state TEXT, reported_at INTEGER, updated_at INTEGER NOT NULL)"
      ),
      env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS cheat_command (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created_at INTEGER NOT NULL, claimed_at INTEGER, finished_at INTEGER)"
      ),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_cheat_command_pick ON cheat_command(guild_id, status, created_at)"
      ),
      env.DB.prepare("CREATE TABLE IF NOT EXISTS cheat_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    ]).then(() => undefined);
    schemaReady.set(env.DB, ready);
    ready.catch(() => schemaReady.delete(env.DB));
  }
  await ready;
}

type GuildRow = {
  guild_id: string;
  config: string;
  rev: number;
  state: string | null;
  reported_at: number | null;
};

function parseJson(text: string | null | undefined): any {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type CheatGuild = {
  guildId: string;
  config: CheatConfig;
  rev: number;
  state: CheatGuildState | null;
  reportedAt: number | null;
};

function toGuild(row: GuildRow): CheatGuild {
  const state = parseJson(row.state);
  return {
    guildId: row.guild_id,
    config: mergeConfig(parseJson(row.config)),
    rev: row.rev,
    state: state ? mergeState(state) : null,
    reportedAt: row.reported_at
  };
}

export async function getCheatGuild(env: Env, guildId: string): Promise<CheatGuild | null> {
  await ensureCheatSchema(env);
  const row = await env.DB.prepare(
    "SELECT guild_id, config, rev, state, reported_at FROM cheat_guild WHERE guild_id=?"
  )
    .bind(guildId)
    .first<GuildRow>();
  return row ? toGuild(row) : null;
}

/** 行が無ければ既定設定で作る(Botが先に参加サーバーを報告する/管理画面が先に開く、どちらでも成立)。 */
export async function ensureCheatGuild(env: Env, guildId: string): Promise<CheatGuild> {
  await ensureCheatSchema(env);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO cheat_guild(guild_id, config, rev, updated_at) VALUES (?,?,1,?)"
  )
    .bind(guildId, JSON.stringify(defaultConfig()), Date.now())
    .run();
  const guild = await getCheatGuild(env, guildId);
  if (!guild) throw new Error("CHEAT_GUILD_MISSING");
  return guild;
}

/** rev を条件に更新する(同時に別の保存が入っていたら失敗して呼び出し側が再試行する)。 */
export async function saveCheatConfig(env: Env, guildId: string, patch: unknown): Promise<CheatGuild> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await ensureCheatGuild(env, guildId);
    const next = applyPatch(current.config, patch);
    const result = await env.DB.prepare(
      "UPDATE cheat_guild SET config=?, rev=rev+1, updated_at=? WHERE guild_id=? AND rev=?"
    )
      .bind(JSON.stringify(next), Date.now(), guildId, current.rev)
      .run();
    if ((result.meta?.changes ?? 0) > 0) {
      const saved = await getCheatGuild(env, guildId);
      if (saved) return saved;
    }
  }
  throw new Error("CHEAT_CONFIG_CONFLICT");
}

export async function saveCheatState(env: Env, guildId: string, state: unknown): Promise<void> {
  await ensureCheatGuild(env, guildId);
  const normalized = mergeState(state);
  await env.DB.prepare("UPDATE cheat_guild SET state=?, reported_at=? WHERE guild_id=?")
    .bind(JSON.stringify(normalized), Date.now(), guildId)
    .run();
}

export async function touchLastSeen(env: Env, now = Date.now()): Promise<void> {
  await ensureCheatSchema(env);
  // 30秒以内に更新済みなら行は書き換わらない(D1の書き込み回数を抑える)
  await env.DB.prepare(
    "INSERT INTO cheat_meta(key,value) VALUES ('last_seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(cheat_meta.value AS INTEGER) < ?"
  )
    .bind(String(now), now - 30_000)
    .run();
}

export async function getLastSeen(env: Env): Promise<number | null> {
  await ensureCheatSchema(env);
  const row = await env.DB.prepare("SELECT value FROM cheat_meta WHERE key='last_seen'").first<{ value: string }>();
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

type CommandRow = {
  id: string;
  guild_id: string;
  kind: string;
  payload: string;
  status: string;
  result: string | null;
  created_at: number;
  finished_at: number | null;
};

function toCommand(row: CommandRow): CheatCommand {
  return {
    id: row.id,
    guildId: row.guild_id,
    kind: row.kind as CheatCommandKind,
    payload: parseJson(row.payload) ?? {},
    status: row.status as CheatCommandStatus,
    result: parseJson(row.result),
    createdAt: row.created_at,
    finishedAt: row.finished_at
  };
}

export async function enqueueCheatCommand(
  env: Env,
  guildId: string,
  kind: CheatCommandKind,
  payload: Record<string, unknown>
): Promise<string> {
  await ensureCheatSchema(env);
  const pending = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM cheat_command WHERE guild_id=? AND status IN ('pending','running')"
  )
    .bind(guildId)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_PER_GUILD) {
    throw new CheatInputError("未処理の依頼が溜まっています。Discord-Cheat BOTが起動しているか確認してください");
  }
  const id = randomId();
  await env.DB.prepare(
    "INSERT INTO cheat_command(id, guild_id, kind, payload, status, created_at) VALUES (?,?,?,?, 'pending', ?)"
  )
    .bind(id, guildId, kind, JSON.stringify(payload), Date.now())
    .run();
  return id;
}

export async function getCheatCommand(env: Env, guildId: string, id: string): Promise<CheatCommand | null> {
  await ensureCheatSchema(env);
  const row = await env.DB.prepare(
    "SELECT id, guild_id, kind, payload, status, result, created_at, finished_at FROM cheat_command WHERE id=? AND guild_id=?"
  )
    .bind(id, guildId)
    .first<CommandRow>();
  return row ? toCommand(row) : null;
}

/** pending(と、取りに行ったまま結果が戻らない古いrunning)を running にして返す。 */
export async function claimCheatCommands(env: Env, guildIds: string[], limit = 10): Promise<CheatCommand[]> {
  await ensureCheatSchema(env);
  if (guildIds.length === 0) return [];
  const now = Date.now();
  const marks = guildIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    "SELECT id, guild_id, kind, payload, status, result, created_at, finished_at FROM cheat_command " +
      "WHERE guild_id IN (" + marks + ") AND (status='pending' OR (status='running' AND claimed_at < ?)) " +
      "ORDER BY created_at LIMIT ?"
  )
    .bind(...guildIds, now - COMMAND_RECLAIM_MS, limit)
    .all<CommandRow>();
  const claimed: CheatCommand[] = [];
  for (const row of rows.results ?? []) {
    const update = await env.DB.prepare(
      "UPDATE cheat_command SET status='running', claimed_at=? WHERE id=? AND (status='pending' OR (status='running' AND claimed_at < ?))"
    )
      .bind(now, row.id, now - COMMAND_RECLAIM_MS)
      .run();
    if ((update.meta?.changes ?? 0) > 0) claimed.push(toCommand({ ...row, status: "running" }));
  }
  if (Math.random() < 0.05) {
    await env.DB.prepare("DELETE FROM cheat_command WHERE finished_at IS NOT NULL AND finished_at < ?")
      .bind(now - COMMAND_KEEP_MS)
      .run();
  }
  return claimed;
}

export async function finishCheatCommand(
  env: Env,
  id: string,
  ok: boolean,
  result: Record<string, unknown>
): Promise<boolean> {
  await ensureCheatSchema(env);
  const update = await env.DB.prepare(
    "UPDATE cheat_command SET status=?, result=?, finished_at=? WHERE id=? AND status IN ('pending','running')"
  )
    .bind(ok ? "done" : "failed", JSON.stringify(result).slice(0, 4000), Date.now(), id)
    .run();
  return (update.meta?.changes ?? 0) > 0;
}

export type CheatView = {
  guildId: string;
  guildName: string;
  online: boolean;
  reported: boolean;
  lastSeenAt: number | null;
  games: typeof CHEAT_GAME_META;
  panels: Record<CheatGame, CheatPanelConfig & CheatPanelState>;
  achievements: CheatAchievementConfig & { counters: Record<CheatGame, number> };
  channels: CheatChannel[];
};

/** 管理画面に返す形: 保存済み設定 + Botが最後に報告した状態(チャンネル/設置済みパネル/実績件数)。 */
export function buildCheatView(guild: CheatGuild, lastSeenAt: number | null, now = Date.now()): CheatView {
  const state = guild.state ?? defaultState();
  const panels = {} as CheatView["panels"];
  for (const key of CHEAT_GAMES) panels[key] = { ...guild.config.panels[key], ...state.panels[key] };
  return {
    guildId: guild.guildId,
    guildName: state.guildName,
    online: lastSeenAt !== null && now - lastSeenAt <= ONLINE_WINDOW_MS,
    reported: guild.state !== null,
    lastSeenAt,
    games: CHEAT_GAME_META,
    panels,
    achievements: { ...guild.config.achievements, counters: state.counters },
    channels: state.channels
  };
}
