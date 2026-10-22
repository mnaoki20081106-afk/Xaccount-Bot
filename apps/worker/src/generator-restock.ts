import type { Env } from "./types";
import { randomId, json } from "./utils";
import { requireGuild, VendingHttpError } from "./vending";
import {
  ensureVendingSchema,
  getMachine,
  getVmProduct,
  addStock,
  type Vm,
  type VmProduct
} from "./vending-db";
import { popGeneratorAccounts } from "./generator-client";

// Lets an operator pick an already-installed 自販機Bot machine + product and
// have its finite stock kept topped up automatically from the X-Account
// Generator, instead of pasting/importing stock by hand. One rule per
// product: when available stock drops below min_stock, pop up to max_batch
// CLEAN accounts and add them as stock, aiming for target_stock.
//
// Scope: 自販機Bot (this worker's own vending_machines/vending_products)
// only. 仕入れBot (Discord-Shiire) products are restocked through its own
// supplier/pool procurement engine, which this worker does not own — wiring
// that up needs a bridge-authenticated endpoint on the Discord-Shiire side
// first, which has not been built yet.

export type RestockRule = {
  id: string;
  guild_id: string;
  vending_machine_id: string;
  product_id: string;
  min_stock: number;
  target_stock: number;
  max_batch: number;
  enabled: number;
  last_run_at: number | null;
  last_added: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

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

function validatePolicy(minStock: number, targetStock: number, maxBatch: number) {
  if (!Number.isInteger(minStock) || minStock < 0 || minStock > 10_000) {
    throw new VendingHttpError(400, "最低在庫数は0〜10000で指定してください");
  }
  if (!Number.isInteger(targetStock) || targetStock < minStock || targetStock > 10_000) {
    throw new VendingHttpError(400, "目標在庫数は最低在庫数以上、10000以下で指定してください");
  }
  if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 200) {
    throw new VendingHttpError(400, "1回あたりの補充上限は1〜200で指定してください");
  }
}

async function resolveMachineAndProduct(
  env: Env,
  guildId: string,
  vendingMachineId: string,
  productId: string
): Promise<{ machine: Vm; product: VmProduct }> {
  const machine = await getMachine(env, vendingMachineId);
  if (!machine || machine.guild_id !== guildId) {
    throw new VendingHttpError(404, "自販機が見つかりません");
  }
  const product = await getVmProduct(env, productId);
  if (!product || product.vending_machine_id !== vendingMachineId) {
    throw new VendingHttpError(404, "商品が見つかりません");
  }
  if (product.infinite_stock) {
    throw new VendingHttpError(400, "無限在庫の商品には自動補充を設定できません");
  }
  return { machine, product };
}

async function currentStockCount(env: Env, productId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM vending_stock WHERE product_id=? AND state='available'"
  ).bind(productId).first<{ n: number }>();
  return row?.n ?? 0;
}

// Executes one rule immediately: pops accounts from the generator if stock is
// below min_stock, adds them, and records the result on the rule row. Used by
// both the manual "今すぐ補充" action and the periodic sweep.
async function runRule(env: Env, rule: RestockRule): Promise<{ added: number; stockAfter: number }> {
  const now = Date.now();
  try {
    const stock = await currentStockCount(env, rule.product_id);
    if (stock >= rule.min_stock) {
      await env.DB.prepare(
        "UPDATE vending_auto_restock SET last_run_at=?,last_added=0,last_error=NULL,updated_at=? WHERE id=?"
      ).bind(now, now, rule.id).run();
      return { added: 0, stockAfter: stock };
    }
    const needed = Math.min(rule.target_stock - stock, rule.max_batch);
    if (needed <= 0) {
      await env.DB.prepare(
        "UPDATE vending_auto_restock SET last_run_at=?,last_added=0,last_error=NULL,updated_at=? WHERE id=?"
      ).bind(now, now, rule.id).run();
      return { added: 0, stockAfter: stock };
    }
    const lines = await popGeneratorAccounts(env, needed);
    const added = lines.length ? await addStock(env, rule.product_id, lines) : 0;
    await env.DB.prepare(
      "UPDATE vending_auto_restock SET last_run_at=?,last_added=?,last_error=NULL,updated_at=? WHERE id=?"
    ).bind(now, added, now, rule.id).run();
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
// failure (e.g. the generator is unreachable) must not stop the others.
export async function runGeneratorRestockSweep(env: Env): Promise<void> {
  await ensureVendingSchema(env);
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

function serializeRule(rule: RestockRule, machine: Vm | null, product: (VmProduct & { stock_count?: number }) | null) {
  return {
    id: rule.id,
    vendingMachineId: rule.vending_machine_id,
    machineName: machine?.name ?? null,
    productId: rule.product_id,
    productName: product?.name ?? null,
    minStock: rule.min_stock,
    targetStock: rule.target_stock,
    maxBatch: rule.max_batch,
    enabled: Boolean(rule.enabled),
    lastRunAt: rule.last_run_at,
    lastAdded: rule.last_added,
    lastError: rule.last_error,
    createdAt: rule.created_at,
    updatedAt: rule.updated_at
  };
}

// Dispatched from generator-bridge.ts for any /api/guilds/:id/generator/restock-rules* path.
// `suffix` is everything after "/restock-rules" (e.g. "", "/abc123", "/abc123/run-now").
export async function handleGeneratorRestockApi(
  request: Request,
  env: Env,
  guildId: string,
  suffix: string
): Promise<Response> {
  await ensureVendingSchema(env);
  await requireGuild(request, env, guildId);

  if (suffix === "" && request.method === "GET") {
    const rules = await listRules(env, guildId);
    const serialized = await Promise.all(rules.map(async rule => {
      const machine = await getMachine(env, rule.vending_machine_id);
      const product = await getVmProduct(env, rule.product_id);
      return serializeRule(rule, machine, product);
    }));
    return json(env, serialized);
  }

  if (suffix === "" && request.method === "POST") {
    const body = await request.json() as Record<string, unknown>;
    const vendingMachineId = String(body.vendingMachineId ?? "").trim();
    const productId = String(body.productId ?? "").trim();
    const minStock = Number(body.minStock ?? 0);
    const targetStock = Number(body.targetStock ?? 0);
    const maxBatch = Number(body.maxBatch ?? 0);
    const enabled = body.enabled !== false;
    if (!vendingMachineId || !productId) {
      throw new VendingHttpError(400, "自販機と商品を選択してください");
    }
    validatePolicy(minStock, targetStock, maxBatch);
    const { machine, product } = await resolveMachineAndProduct(env, guildId, vendingMachineId, productId);

    const existing = await env.DB.prepare(
      "SELECT id FROM vending_auto_restock WHERE product_id=?"
    ).bind(productId).first<{ id: string }>();
    if (existing) {
      throw new VendingHttpError(409, "この商品にはすでに自動補充ルールがあります");
    }

    const id = randomId();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO vending_auto_restock(id,guild_id,vending_machine_id,product_id,min_stock,target_stock,max_batch,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, guildId, vendingMachineId, productId, minStock, targetStock, maxBatch, enabled ? 1 : 0, now, now).run();

    const rule = await getRule(env, id, guildId);
    return json(env, serializeRule(rule!, machine, product), 201);
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
      const enabled = body.enabled !== undefined ? Boolean(body.enabled) : Boolean(rule.enabled);
      validatePolicy(minStock, targetStock, maxBatch);
      const now = Date.now();
      await env.DB.prepare(
        "UPDATE vending_auto_restock SET min_stock=?,target_stock=?,max_batch=?,enabled=?,updated_at=? WHERE id=?"
      ).bind(minStock, targetStock, maxBatch, enabled ? 1 : 0, now, ruleId).run();
      const updated = await getRule(env, ruleId, guildId);
      const machine = await getMachine(env, updated!.vending_machine_id);
      const product = await getVmProduct(env, updated!.product_id);
      return json(env, serializeRule(updated!, machine, product));
    }

    if (request.method === "DELETE") {
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
