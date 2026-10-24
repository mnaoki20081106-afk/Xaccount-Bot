import type { Env } from "./types";
import { randomId, json, encrypt, decrypt } from "./utils";
import { VendingHttpError } from "./vending";
import {
  ensureVendingSchema,
  getMachine,
  getVmProduct,
  addStock
} from "./vending-db";
import { popGeneratorAccounts } from "./generator-client";
import { signedShiireFetch } from "./shiire-bridge";

// Lets an operator pick an already-installed machine + product and have its
// stock kept topped up automatically from the X-Account Generator, instead of
// pasting/importing stock by hand. One rule per product: when available stock
// drops below min_stock, pop up to max_batch accounts and add them as stock,
// aiming for target_stock.
//
// Two targets are supported:
//   "vending" – 自販機Bot products in this worker's own D1 (vending_stock).
//   "shiire"  – 仕入れBot (Discord-Shiire) vending products, reached through
//               the signed Shiire bridge (generator/products/:id/stock).
//   "invite"  – the invite-campaign reward pool in Discord-Shiire.
//   "giveaway"– the free-giveaway pool in Discord-Shiire.
//               (both through generator/pools/:pool/stock; no machine/product)
//
// Popping marks generator accounts as sold, so accounts that were popped but
// could not be delivered yet are kept (encrypted) on the rule row and
// delivered on the next run before anything else is popped.

type TargetSystem = "vending" | "shiire" | "invite" | "giveaway";

const POOL_BY_SYSTEM: Partial<Record<TargetSystem, { pool: string; label: string }>> = {
  invite: { pool: "invite-campaign", label: "招待キャンペーン" },
  giveaway: { pool: "free-giveaway", label: "無料配布" }
};

function parseTargetSystem(value: unknown): TargetSystem {
  return value === "shiire" || value === "invite" || value === "giveaway" ? value : "vending";
}

// What a delivery needs to know about where accounts go.
type Target = Pick<RestockRule, "target_system" | "guild_id" | "product_id">;

export type RestockRule = {
  id: string;
  guild_id: string;
  target_system: TargetSystem;
  vending_machine_id: string;
  product_id: string;
  min_stock: number;
  target_stock: number;
  max_batch: number;
  min_warmup_days: number;
  enabled: number;
  pending_enc: string | null;
  last_run_at: number | null;
  last_added: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

type ShiireProductRow = {
  id: string;
  name: string;
  procurement_class: string | null;
  stock_count: number;
};
type ShiireMachineRow = { id: string; name: string; products?: ShiireProductRow[] };

function encryptionSecret(env: Env): string {
  const secret = env.SESSION_ENCRYPTION_KEY;
  if (!secret) throw new Error("SESSION_ENCRYPTION_KEY_NOT_CONFIGURED");
  return secret;
}

async function listRules(env: Env, guildId: string): Promise<RestockRule[]> {
  return (
    await env.DB.prepare(
      "SELECT * FROM vending_auto_restock WHERE guild_id=? ORDER BY created_at DESC"
    ).bind(guildId).all<RestockRule>()
  ).results;
}

async function getRule(env: Env, id: string, guildId: string): Promise<RestockRule | null> {
  return (
    await env.DB.prepare(
      "SELECT * FROM vending_auto_restock WHERE id=? AND guild_id=?"
    ).bind(id, guildId).first<RestockRule>()
  ) ?? null;
}

function validatePolicy(minStock: number, targetStock: number, maxBatch: number, minWarmupDays: number) {
  if (!Number.isInteger(minStock) || minStock < 0 || minStock > 10_000) {
    throw new VendingHttpError(400, "最低在庫数は0〜10000で指定してください");
  }
  if (!Number.isInteger(targetStock) || targetStock < minStock || targetStock > 10_000) {
    throw new VendingHttpError(400, "目標在庫数は最低在庫数以上、10000以下で指定してください");
  }
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 200) {
    throw new VendingHttpError(400, "1回あたりの補充上限は1〜200で指定してください");
  }
  if (!Number.isInteger(minWarmupDays) || minWarmupDays < 0 || minWarmupDays > 365) {
    throw new VendingHttpError(400, "最低ウォームアップ日数は0〜365で指定してください");
  }
}

// ── 仕入れBot (Discord-Shiire) access ───────────────────────────────────────

async function shiireJson<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const response = await signedShiireFetch(env, path, init);
  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const detail = (payload as Record<string, unknown> | null)?.message
      ?? (payload as Record<string, unknown> | null)?.error
      ?? response.status;
    throw new Error("SHIIRE_API_ERROR:" + String(detail) + " (HTTP " + response.status + ")");
  }
  return payload as T;
}

async function listShiireMachines(env: Env, guildId: string): Promise<ShiireMachineRow[]> {
  return shiireJson<ShiireMachineRow[]>(env, "/bridge/main/guilds/" + guildId + "/vending");
}

async function shiireStockCount(env: Env, guildId: string, productId: string): Promise<number> {
  const data = await shiireJson<{ stockCount: number }>(
    env,
    "/bridge/main/guilds/" + guildId + "/generator/products/" + encodeURIComponent(productId) + "/stock"
  );
  return Math.max(0, Number(data.stockCount ?? 0));
}

async function shiireAddStock(env: Env, guildId: string, productId: string, lines: string[]): Promise<number> {
  const data = await shiireJson<{ added: number }>(
    env,
    "/bridge/main/guilds/" + guildId + "/generator/products/" + encodeURIComponent(productId) + "/stock",
    { method: "POST", body: JSON.stringify({ items: lines }) }
  );
  return Math.max(0, Number(data.added ?? 0));
}

// ── 自販機Bot (this worker) access ──────────────────────────────────────────

async function vendingStockCount(env: Env, productId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM vending_stock WHERE product_id=? AND state='available'"
  ).bind(productId).first<{ n: number }>();
  return row?.n ?? 0;
}

async function shiirePoolStockCount(env: Env, guildId: string, pool: string): Promise<number> {
  const data = await shiireJson<{ stockCount: number }>(
    env,
    "/bridge/main/guilds/" + guildId + "/generator/pools/" + pool + "/stock"
  );
  return Math.max(0, Number(data.stockCount ?? 0));
}

async function shiirePoolAddStock(env: Env, guildId: string, pool: string, lines: string[]): Promise<number> {
  const data = await shiireJson<{ added: number }>(
    env,
    "/bridge/main/guilds/" + guildId + "/generator/pools/" + pool + "/stock",
    { method: "POST", body: JSON.stringify({ items: lines }) }
  );
  return Math.max(0, Number(data.added ?? 0));
}

async function stockCountFor(env: Env, target: Target): Promise<number> {
  const pool = POOL_BY_SYSTEM[target.target_system];
  if (pool) return shiirePoolStockCount(env, target.guild_id, pool.pool);
  return target.target_system === "shiire"
    ? shiireStockCount(env, target.guild_id, target.product_id)
    : vendingStockCount(env, target.product_id);
}

async function addStockFor(env: Env, target: Target, lines: string[]): Promise<number> {
  const pool = POOL_BY_SYSTEM[target.target_system];
  if (pool) return shiirePoolAddStock(env, target.guild_id, pool.pool, lines);
  return target.target_system === "shiire"
    ? shiireAddStock(env, target.guild_id, target.product_id, lines)
    : addStock(env, target.product_id, lines);
}

// TOP_SEARCH 商品（検索TOPに載る前提で高単価）には卒業テスト合格済みの垢だけを入れる。
// 商品の種別を確認できない時は、誤って未検証の垢を高単価商品に入れないよう失敗させる。
async function tierFor(env: Env, guildId: string, targetSystem: TargetSystem, productId: string): Promise<"any" | "top_search"> {
  if (targetSystem !== "shiire") return "any";
  const machines = await listShiireMachines(env, guildId);
  for (const machine of machines) {
    const product = machine.products?.find(p => p.id === productId);
    if (product) return product.procurement_class === "TOP_SEARCH" ? "top_search" : "any";
  }
  throw new Error("SHIIRE_PRODUCT_CLASS_UNKNOWN");
}

// Delivers lines that were popped earlier but never stored, then clears them.
async function deliverPending(env: Env, rule: RestockRule): Promise<number> {
  const secret = encryptionSecret(env);
  const lines = JSON.parse(await decrypt(secret, rule.pending_enc!)) as string[];
  const added = lines.length ? await addStockFor(env, rule, lines) : 0;
  await env.DB.prepare("UPDATE vending_auto_restock SET pending_enc=NULL WHERE id=?").bind(rule.id).run();
  return added;
}

// Executes one rule immediately. Used by both the manual "今すぐ補充" action
// and the periodic sweep; records the outcome on the rule row.
async function runRule(env: Env, rule: RestockRule): Promise<{ added: number; stockAfter: number }> {
  const now = Date.now();
  const finish = async (added: number, error: string | null) => {
    await env.DB.prepare(
      "UPDATE vending_auto_restock SET last_run_at=?,last_added=?,last_error=?,updated_at=? WHERE id=?"
    ).bind(now, added, error, now, rule.id).run();
  };
  try {
    if (rule.pending_enc) {
      const added = await deliverPending(env, rule);
      const stockAfter = await stockCountFor(env, rule);
      await finish(added, null);
      return { added, stockAfter };
    }

    const stock = await stockCountFor(env, rule);
    const needed = stock < rule.min_stock
      ? Math.min(rule.target_stock - stock, rule.max_batch)
      : 0;
    if (needed <= 0) {
      await finish(0, null);
      return { added: 0, stockAfter: stock };
    }

    const tier = await tierFor(env, rule.guild_id, rule.target_system, rule.product_id);
    const lines = await popGeneratorAccounts(env, needed, { minWarmupDays: rule.min_warmup_days, tier });
    if (lines.length === 0) {
      await finish(0, null);
      return { added: 0, stockAfter: stock };
    }
    // Persist before delivering: the generator already considers these sold.
    const pending = await encrypt(encryptionSecret(env), JSON.stringify(lines));
    await env.DB.prepare("UPDATE vending_auto_restock SET pending_enc=? WHERE id=?").bind(pending, rule.id).run();
    const added = await addStockFor(env, rule, lines);
    await env.DB.prepare("UPDATE vending_auto_restock SET pending_enc=NULL WHERE id=?").bind(rule.id).run();
    await finish(added, null);
    return { added, stockAfter: stock + added };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      "UPDATE vending_auto_restock SET last_run_at=?,last_error=?,updated_at=? WHERE id=?"
    ).bind(now, message.slice(0, 300), now, rule.id).run();
    throw error;
  }
}

// Cron entry point: sweeps every enabled rule across every guild. One rule's
// failure (e.g. the generator or a bridge is unreachable) must not stop the others.
export async function runGeneratorRestockSweep(env: Env): Promise<void> {
  await ensureVendingSchema(env);
  try {
    await retryPendingDeliveries(env);
  } catch (error) {
    console.error("generator pending delivery retry failed", error);
  }
  const rules = (
    await env.DB.prepare(
      "SELECT * FROM vending_auto_restock WHERE enabled=1"
    ).all<RestockRule>()
  ).results;
  for (const rule of rules) {
    try {
      await runRule(env, rule);
    } catch (error) {
      console.error("generator restock rule failed", rule.id, error);
    }
  }
}

// ── Manual assignment ("今すぐ割り当て") ─────────────────────────────────────
//
// Pops N accounts and puts them into a target. The generator treats popped
// accounts as sold, so they are written (encrypted) to
// generator_pending_deliveries before delivery is attempted; if delivery
// fails the row stays and the minute sweep keeps retrying it.

type PendingRow = {
  id: string;
  guild_id: string;
  target_system: TargetSystem;
  vending_machine_id: string;
  product_id: string;
  payload_enc: string;
  line_count: number;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

async function attemptPendingDelivery(env: Env, row: PendingRow): Promise<number> {
  const lines = JSON.parse(await decrypt(encryptionSecret(env), row.payload_enc)) as string[];
  try {
    const added = await addStockFor(env, row, lines);
    await env.DB.prepare("DELETE FROM generator_pending_deliveries WHERE id=?").bind(row.id).run();
    return added;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.DB.prepare(
      "UPDATE generator_pending_deliveries SET attempts=attempts+1,last_error=?,updated_at=? WHERE id=?"
    ).bind(message.slice(0, 300), Date.now(), row.id).run();
    throw error;
  }
}

async function retryPendingDeliveries(env: Env): Promise<void> {
  const rows = (
    await env.DB.prepare(
      "SELECT * FROM generator_pending_deliveries ORDER BY created_at ASC LIMIT 20"
    ).all<PendingRow>()
  ).results;
  for (const row of rows) {
    try {
      await attemptPendingDelivery(env, row);
    } catch (error) {
      console.error("generator pending delivery failed", row.id, error);
    }
  }
}

// Thrown when accounts were popped but could not be delivered yet. They are
// safely stored and the sweep retries them.
class DeliveryPendingError extends Error {}

async function assignToTarget(
  env: Env,
  guildId: string,
  targetSystem: TargetSystem,
  machineId: string,
  productId: string,
  count: number,
  minWarmupDays: number
): Promise<{ popped: number; added: number }> {
  const tier = await tierFor(env, guildId, targetSystem, productId);
  const lines = await popGeneratorAccounts(env, count, { minWarmupDays, tier });
  if (lines.length === 0) return { popped: 0, added: 0 };

  const id = randomId();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO generator_pending_deliveries(id,guild_id,target_system,vending_machine_id,product_id,payload_enc,line_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(
    id, guildId, targetSystem, machineId, productId,
    await encrypt(encryptionSecret(env), JSON.stringify(lines)), lines.length, now, now
  ).run();
  const row = await env.DB.prepare("SELECT * FROM generator_pending_deliveries WHERE id=?").bind(id).first<PendingRow>();
  try {
    const added = await attemptPendingDelivery(env, row!);
    return { popped: lines.length, added };
  } catch (error) {
    throw new DeliveryPendingError(error instanceof Error ? error.message : String(error));
  }
}

export async function handleGeneratorAssignApi(
  request: Request,
  env: Env,
  guildId: string
): Promise<Response> {
  await ensureVendingSchema(env);

  if (request.method === "GET") {
    const rows = (
      await env.DB.prepare(
        "SELECT * FROM generator_pending_deliveries WHERE guild_id=? ORDER BY created_at ASC"
      ).bind(guildId).all<PendingRow>()
    ).results;
    return json(env, {
      pending: rows.map(row => ({
        id: row.id,
        targetSystem: row.target_system,
        productId: row.product_id,
        count: row.line_count,
        attempts: row.attempts,
        lastError: row.last_error,
        createdAt: row.created_at
      }))
    });
  }

  if (request.method !== "POST") throw new VendingHttpError(404, "見つかりません");
  const body = await request.json() as Record<string, unknown>;
  const targetSystem = parseTargetSystem(body.targetSystem);
  const pool = POOL_BY_SYSTEM[targetSystem];
  const machineId = pool ? "" : String(body.vendingMachineId ?? "").trim();
  const productId = pool ? pool.pool : String(body.productId ?? "").trim();
  const count = Number(body.count ?? 0);
  const minWarmupDays = Number(body.minWarmupDays ?? 0);
  if (!pool && (!machineId || !productId)) {
    throw new VendingHttpError(400, "自販機と商品を選択してください");
  }
  if (!Number.isInteger(count) || count < 1 || count > 200) {
    throw new VendingHttpError(400, "件数は1〜200で指定してください");
  }
  if (!Number.isInteger(minWarmupDays) || minWarmupDays < 0 || minWarmupDays > 365) {
    throw new VendingHttpError(400, "最低ウォームアップ日数は0〜365で指定してください");
  }
  await resolveTarget(env, guildId, targetSystem, machineId, productId);

  try {
    const result = await assignToTarget(env, guildId, targetSystem, machineId, productId, count, minWarmupDays);
    return json(env, { ok: true, ...result });
  } catch (error) {
    if (!(error instanceof DeliveryPendingError)) throw error;
    // The accounts were already popped: they are kept and retried every minute.
    return json(env, {
      error: "取り出した垢は保管済みで、1分ごとに自動で再納品します。原因: " + error.message.slice(0, 200)
    }, 502);
  }
}

function serializeRule(rule: RestockRule, machineName: string | null, productName: string | null) {
  return {
    id: rule.id,
    targetSystem: rule.target_system,
    vendingMachineId: rule.vending_machine_id,
    machineName,
    productId: rule.product_id,
    productName,
    minStock: rule.min_stock,
    targetStock: rule.target_stock,
    maxBatch: rule.max_batch,
    minWarmupDays: rule.min_warmup_days,
    enabled: Boolean(rule.enabled),
    pendingDelivery: Boolean(rule.pending_enc),
    lastRunAt: rule.last_run_at,
    lastAdded: rule.last_added,
    lastError: rule.last_error,
    createdAt: rule.created_at,
    updatedAt: rule.updated_at
  };
}

async function namesFor(
  env: Env,
  rule: RestockRule,
  shiireMachines: ShiireMachineRow[] | null
): Promise<{ machineName: string | null; productName: string | null }> {
  const pool = POOL_BY_SYSTEM[rule.target_system];
  if (pool) return { machineName: pool.label, productName: "在庫プール" };
  if (rule.target_system === "shiire") {
    const machine = shiireMachines?.find(row => row.id === rule.vending_machine_id) ?? null;
    return {
      machineName: machine?.name ?? null,
      productName: machine?.products?.find(row => row.id === rule.product_id)?.name ?? null
    };
  }
  const machine = await getMachine(env, rule.vending_machine_id);
  const product = await getVmProduct(env, rule.product_id);
  return { machineName: machine?.name ?? null, productName: product?.name ?? null };
}

async function resolveTarget(
  env: Env,
  guildId: string,
  targetSystem: TargetSystem,
  machineId: string,
  productId: string
): Promise<{ machineName: string; productName: string }> {
  const pool = POOL_BY_SYSTEM[targetSystem];
  if (pool) return { machineName: pool.label, productName: "在庫プール" };
  if (targetSystem === "shiire") {
    const machines = await listShiireMachines(env, guildId);
    const machine = machines.find(row => row.id === machineId);
    if (!machine) throw new VendingHttpError(404, "自販機が見つかりません");
    const product = machine.products?.find(row => row.id === productId);
    if (!product) throw new VendingHttpError(404, "商品が見つかりません");
    return { machineName: machine.name, productName: product.name };
  }
  const machine = await getMachine(env, machineId);
  if (!machine || machine.guild_id !== guildId) {
    throw new VendingHttpError(404, "自販機が見つかりません");
  }
  const product = await getVmProduct(env, productId);
  if (!product || product.vending_machine_id !== machineId) {
    throw new VendingHttpError(404, "商品が見つかりません");
  }
  if (product.infinite_stock) {
    throw new VendingHttpError(400, "無限在庫の商品には自動補充を設定できません");
  }
  return { machineName: machine.name, productName: product.name };
}

// Dispatched from generator-bridge.ts for any /api/guilds/:id/generator/restock-rules* path.
// `suffix` is everything after "/restock-rules" (e.g. "", "/abc123", "/abc123/run-now").
export async function handleGeneratorRestockApi(
  request: Request,
  env: Env,
  guildId: string,
  suffix: string
): Promise<Response> {
  // Authentication happens once in handleGeneratorBridge before dispatching here.
  await ensureVendingSchema(env);

  if (suffix === "" && request.method === "GET") {
    const rules = await listRules(env, guildId);
    let shiireMachines: ShiireMachineRow[] | null = null;
    if (rules.some(rule => rule.target_system === "shiire")) {
      shiireMachines = await listShiireMachines(env, guildId).catch(() => null);
    }
    const serialized = await Promise.all(rules.map(async rule => {
      const names = await namesFor(env, rule, shiireMachines);
      return serializeRule(rule, names.machineName, names.productName);
    }));
    return json(env, serialized);
  }

  if (suffix === "" && request.method === "POST") {
    const body = await request.json() as Record<string, unknown>;
    const targetSystem = parseTargetSystem(body.targetSystem);
    const pool = POOL_BY_SYSTEM[targetSystem];
    // A pool has no machine or product: the pool name is its identity.
    const vendingMachineId = pool ? "" : String(body.vendingMachineId ?? "").trim();
    const productId = pool ? pool.pool : String(body.productId ?? "").trim();
    const minStock = Number(body.minStock ?? 0);
    const targetStock = Number(body.targetStock ?? 0);
    const maxBatch = Number(body.maxBatch ?? 0);
    const minWarmupDays = Number(body.minWarmupDays ?? 0);
    const enabled = body.enabled !== false;
    if (!pool && (!vendingMachineId || !productId)) {
      throw new VendingHttpError(400, "自販機と商品を選択してください");
    }
    validatePolicy(minStock, targetStock, maxBatch, minWarmupDays);
    const names = await resolveTarget(env, guildId, targetSystem, vendingMachineId, productId);

    const existing = await env.DB.prepare(
      "SELECT id FROM vending_auto_restock WHERE product_id=?"
    ).bind(productId).first<{ id: string }>();
    if (existing) {
      throw new VendingHttpError(409, "この商品にはすでに自動補充ルールがあります");
    }

    const id = randomId();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO vending_auto_restock(id,guild_id,target_system,vending_machine_id,product_id,min_stock,target_stock,max_batch,min_warmup_days,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, guildId, targetSystem, vendingMachineId, productId, minStock, targetStock, maxBatch, minWarmupDays, enabled ? 1 : 0, now, now).run();

    const rule = await getRule(env, id, guildId);
    return json(env, serializeRule(rule!, names.machineName, names.productName), 201);
  }

  const ruleMatch = suffix.match(/^\/([^/]+)$/);
  if (ruleMatch) {
    const ruleId = ruleMatch[1]!;
    const rule = await getRule(env, ruleId, guildId);
    if (!rule) throw new VendingHttpError(404, "自動補充ルールが見つかりません");

    if (request.method === "PATCH") {
      const body = await request.json() as Record<string, unknown>;
      const minStock = body.minStock !== undefined ? Number(body.minStock) : rule.min_stock;
      const targetStock = body.targetStock !== undefined ? Number(body.targetStock) : rule.target_stock;
      const maxBatch = body.maxBatch !== undefined ? Number(body.maxBatch) : rule.max_batch;
      const minWarmupDays = body.minWarmupDays !== undefined ? Number(body.minWarmupDays) : rule.min_warmup_days;
      const enabled = body.enabled !== undefined ? Boolean(body.enabled) : Boolean(rule.enabled);
      validatePolicy(minStock, targetStock, maxBatch, minWarmupDays);
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE vending_auto_restock SET min_stock=?,target_stock=?,max_batch=?,min_warmup_days=?,enabled=?,updated_at=? WHERE id=?"
      ).bind(minStock, targetStock, maxBatch, minWarmupDays, enabled ? 1 : 0, now, ruleId).run();
      const updated = await getRule(env, ruleId, guildId);
      const shiireMachines = updated!.target_system === "shiire"
        ? await listShiireMachines(env, guildId).catch(() => null)
        : null;
      const names = await namesFor(env, updated!, shiireMachines);
      return json(env, serializeRule(updated!, names.machineName, names.productName));
    }

    if (request.method === "DELETE") {
      if (rule.pending_enc) {
        throw new VendingHttpError(409, "補充待ちのアカウントがあります。「今すぐ補充」で納品を完了してから削除してください");
      }
      await env.DB.prepare("DELETE FROM vending_auto_restock WHERE id=? AND guild_id=?").bind(ruleId, guildId).run();
      return json(env, { ok: true });
    }
  }

  const runNowMatch = suffix.match(/^\/([^/]+)\/run-now$/);
  if (runNowMatch && request.method === "POST") {
    const ruleId = runNowMatch[1]!;
    const rule = await getRule(env, ruleId, guildId);
    if (!rule) throw new VendingHttpError(404, "自動補充ルールが見つかりません");
    const result = await runRule(env, rule);
    return json(env, { ok: true, ...result });
  }

  throw new VendingHttpError(404, "見つかりません");
}
