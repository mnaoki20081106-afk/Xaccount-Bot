import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type Props = {
  guildId: string;
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
};

type Feedback = { kind: "success" | "error" | "info"; message: string };

type InventoryData = {
  total: number;
  clean: number;
  warming: number;
  created: number;
  soft_shadow: number;
  hard_shadow: number;
  locked: number;
  suspended: number;
  sold: number;
};

type StatusData = {
  total: number;
  by_status: Record<string, number>;
  orchestrator_running: boolean;
  orchestrator_target: number;
  orchestrator_started_at: number | null;
};

type ConfigData = {
  proxy: { provider: string; host: string; port: number; country: string; sticky_ttl_minutes: number; max_accounts_per_ip: number };
  sms: { provider: string; preferred_countries: string[] };
  captcha: { provider: string; provider_fallback: string };
  factory: { max_per_hour: number; use_phone: boolean; setup_profile: boolean };
  warmup: { min_days_before_sale: number; actions_per_day_soft: number };
};

type AccountRow = {
  id: number;
  username: string;
  status: string;
  shadow_score: number;
  proxy_id: string | null;
  created_at: string | null;
  last_action_at: string | null;
  sold_at: string | null;
  notes: string | null;
};

type ActiveTab = "status" | "inventory" | "accounts" | "generate" | "push" | "restock";

type VendingMachineRow = { id: string; name: string };
type VendingProductRow = { id: string; name: string; infinite_stock: number; stock_count: number };
type VendingMachineDetail = VendingMachineRow & { products: VendingProductRow[] };

type RestockRule = {
  id: string;
  vendingMachineId: string;
  machineName: string | null;
  productId: string;
  productName: string | null;
  minStock: number;
  targetStock: number;
  maxBatch: number;
  enabled: boolean;
  lastRunAt: number | null;
  lastAdded: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

const STATUS_LABEL: Record<string, string> = {
  clean: "CLEAN",
  warming: "WARMING",
  created: "CREATED",
  soft_shadow: "SOFT SHADOW",
  hard_shadow: "HARD SHADOW",
  locked: "LOCKED",
  suspended: "SUSPENDED",
  sold: "SOLD"
};

const STATUS_TONE: Record<string, "good" | "warn" | "bad" | ""> = {
  clean: "good",
  warming: "warn",
  created: "",
  soft_shadow: "warn",
  hard_shadow: "bad",
  locked: "bad",
  suspended: "bad",
  sold: ""
};

function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? "";
  return (
    <span className={`status-pill ${tone}`}>
      <i />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export default function XGeneratorManager({ guildId, onNotice, onError }: Props) {
  const [activeTab, setActiveTab] = useState<ActiveTab>("status");

  const [status, setStatus] = useState<StatusData | null>(null);
  const [statusFeedback, setStatusFeedback] = useState<Feedback | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [inventory, setInventory] = useState<InventoryData | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [accountFilter, setAccountFilter] = useState("");
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsFeedback, setAccountsFeedback] = useState<Feedback | null>(null);

  const [config, setConfig] = useState<ConfigData | null>(null);
  const [configFeedback, setConfigFeedback] = useState<Feedback | null>(null);

  const [genCount, setGenCount] = useState("3");
  const [genConcurrency, setGenConcurrency] = useState("2");
  const [genBusy, setGenBusy] = useState(false);
  const [genFeedback, setGenFeedback] = useState<Feedback | null>(null);

  const [pushCount, setPushCount] = useState("10");
  const [pushSupplierId, setPushSupplierId] = useState("");
  const [pushSku, setPushSku] = useState("");
  const [pushMinDays, setPushMinDays] = useState("0");
  const [pushAllowSoft, setPushAllowSoft] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushFeedback, setPushFeedback] = useState<Feedback | null>(null);

  const [restockMachines, setRestockMachines] = useState<VendingMachineRow[]>([]);
  const [restockMachineId, setRestockMachineId] = useState("");
  const [restockMachineDetail, setRestockMachineDetail] = useState<VendingMachineDetail | null>(null);
  const [restockProductId, setRestockProductId] = useState("");
  const [restockMinStock, setRestockMinStock] = useState("5");
  const [restockTargetStock, setRestockTargetStock] = useState("20");
  const [restockMaxBatch, setRestockMaxBatch] = useState("10");
  const [restockRules, setRestockRules] = useState<RestockRule[]>([]);
  const [restockLoading, setRestockLoading] = useState(false);
  const [restockBusy, setRestockBusy] = useState(false);
  const [restockFeedback, setRestockFeedback] = useState<Feedback | null>(null);

  const base = "/api/guilds/" + guildId + "/generator";
  const vendingBase = "/api/guilds/" + guildId + "/vending";

  const loadStatus = useCallback(() => {
    setStatusLoading(true);
    setStatusFeedback(null);
    api<StatusData>(base + "/status")
      .then(data => setStatus(data))
      .catch(err => setStatusFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setStatusLoading(false));
  }, [base]);

  const loadInventory = useCallback(() => {
    setInventoryLoading(true);
    api<InventoryData>(base + "/inventory")
      .then(data => setInventory(data))
      .catch(err => onError(err))
      .finally(() => setInventoryLoading(false));
  }, [base, onError]);

  const loadAccounts = useCallback(() => {
    setAccountsLoading(true);
    setAccountsFeedback(null);
    const qs = accountFilter ? "?status=" + encodeURIComponent(accountFilter) + "&limit=200" : "?limit=200";
    api<{ accounts: AccountRow[] }>(base + "/accounts" + qs)
      .then(data => setAccounts(data.accounts))
      .catch(err => setAccountsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setAccountsLoading(false));
  }, [base, accountFilter]);

  const loadConfig = useCallback(() => {
    setConfigFeedback(null);
    api<ConfigData>(base + "/config")
      .then(data => setConfig(data))
      .catch(err => setConfigFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [base]);

  const loadRestockRules = useCallback(() => {
    setRestockLoading(true);
    api<RestockRule[]>(base + "/restock-rules")
      .then(data => setRestockRules(data))
      .catch(err => setRestockFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setRestockLoading(false));
  }, [base]);

  const loadRestockMachines = useCallback(() => {
    api<VendingMachineRow[]>(vendingBase)
      .then(data => setRestockMachines(data))
      .catch(err => setRestockFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [vendingBase]);

  useEffect(() => {
    if (activeTab === "status") loadStatus();
    if (activeTab === "inventory") loadInventory();
    if (activeTab === "accounts") loadAccounts();
    if (activeTab === "generate") { loadStatus(); loadConfig(); }
    if (activeTab === "restock") { loadRestockRules(); loadRestockMachines(); }
  }, [activeTab]);

  useEffect(() => {
    if (!restockMachineId) {
      setRestockMachineDetail(null);
      setRestockProductId("");
      return;
    }
    api<VendingMachineDetail>(vendingBase + "/" + restockMachineId)
      .then(data => {
        setRestockMachineDetail(data);
        setRestockProductId(data.products.find(p => !p.infinite_stock)?.id ?? "");
      })
      .catch(err => setRestockFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [restockMachineId, vendingBase]);

  const handleCreateRestockRule = () => {
    const minStock = parseInt(restockMinStock, 10);
    const targetStock = parseInt(restockTargetStock, 10);
    const maxBatch = parseInt(restockMaxBatch, 10);
    if (!restockMachineId || !restockProductId) {
      setRestockFeedback({ kind: "error", message: "自販機と商品を選択してください" });
      return;
    }
    if (!Number.isInteger(minStock) || minStock < 0 || !Number.isInteger(targetStock) || targetStock < minStock || !Number.isInteger(maxBatch) || maxBatch < 1) {
      setRestockFeedback({ kind: "error", message: "最低在庫・目標在庫・補充上限を正しく入力してください" });
      return;
    }
    setRestockBusy(true);
    setRestockFeedback(null);
    api(base + "/restock-rules", {
      method: "POST",
      body: JSON.stringify({ vendingMachineId: restockMachineId, productId: restockProductId, minStock, targetStock, maxBatch }),
      headers: { "Content-Type": "application/json" }
    })
      .then(() => {
        onNotice("自動補充ルールを作成しました");
        loadRestockRules();
      })
      .catch(err => setRestockFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setRestockBusy(false));
  };

  const toggleRestockRule = (rule: RestockRule) => {
    setRestockBusy(true);
    api(base + "/restock-rules/" + rule.id, {
      method: "PATCH",
      body: JSON.stringify({ enabled: !rule.enabled }),
      headers: { "Content-Type": "application/json" }
    })
      .then(() => loadRestockRules())
      .catch(err => onError(err))
      .finally(() => setRestockBusy(false));
  };

  const deleteRestockRule = (rule: RestockRule) => {
    if (!confirm((rule.productName ?? rule.productId) + " の自動補充ルールを削除しますか？")) return;
    setRestockBusy(true);
    api(base + "/restock-rules/" + rule.id, { method: "DELETE" })
      .then(() => {
        onNotice("自動補充ルールを削除しました");
        loadRestockRules();
      })
      .catch(err => onError(err))
      .finally(() => setRestockBusy(false));
  };

  const runRestockNow = (rule: RestockRule) => {
    setRestockBusy(true);
    api<{ ok: boolean; added: number; stockAfter: number }>(base + "/restock-rules/" + rule.id + "/run-now", { method: "POST" })
      .then(data => {
        onNotice(data.added > 0 ? data.added + " 垢を補充しました（在庫 " + data.stockAfter + "）" : "在庫は十分です。補充は行われませんでした");
        loadRestockRules();
      })
      .catch(err => onError(err))
      .finally(() => setRestockBusy(false));
  };

  const handleGenerate = () => {
    const count = parseInt(genCount, 10);
    const concurrency = parseInt(genConcurrency, 10);
    if (!Number.isInteger(count) || count < 1 || count > 100) {
      setGenFeedback({ kind: "error", message: "生成数は 1〜100 で指定してください" });
      return;
    }
    setGenBusy(true);
    setGenFeedback(null);
    api(base + "/generate", {
      method: "POST",
      body: JSON.stringify({ count, concurrency }),
      headers: { "Content-Type": "application/json" }
    })
      .then(() => {
        setGenFeedback({ kind: "success", message: "生成ジョブを開始しました (" + count + " 垢)" });
        onNotice("垢生成を開始しました");
        loadStatus();
      })
      .catch(err => setGenFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setGenBusy(false));
  };

  const handlePush = () => {
    const count = parseInt(pushCount, 10);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      setPushFeedback({ kind: "error", message: "件数は 1〜200 で指定してください" });
      return;
    }
    if (!pushSupplierId.trim() || !pushSku.trim()) {
      setPushFeedback({ kind: "error", message: "サプライヤーIDとSKUを入力してください" });
      return;
    }
    setPushBusy(true);
    setPushFeedback(null);
    api<{ ok: boolean; popped: number; added: number }>(
      base + "/push-to-shiire",
      {
        method: "POST",
        body: JSON.stringify({
          count,
          supplierId: pushSupplierId.trim(),
          sku: pushSku.trim(),
          minWarmupDays: parseInt(pushMinDays, 10) || 0,
          allowSoftShadow: pushAllowSoft
        }),
        headers: { "Content-Type": "application/json" }
      }
    )
      .then(data => {
        setPushFeedback({ kind: "success", message: data.popped + " 垢をジェネレーターから取得し、" + data.added + " 垢を自販機プールに追加しました" });
        onNotice("垢を自販機に追加しました: " + data.added + " 垢");
      })
      .catch(err => setPushFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setPushBusy(false));
  };

  const tabs: { key: ActiveTab; label: string }[] = [
    { key: "status", label: "ステータス" },
    { key: "inventory", label: "在庫" },
    { key: "accounts", label: "アカウント" },
    { key: "generate", label: "垢生成" },
    { key: "push", label: "仕入れbotに追加" },
    { key: "restock", label: "自動補充" }
  ];

  return (
    <div className="x-generator-manager">
      <section className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">X ACCOUNT GENERATOR</span>
            <h2>垢生成管理</h2>
            <p className="muted">アカウント生成botの稼働状況・在庫・生成・自販機への追加をまとめて管理します。</p>
          </div>
        </div>

        <nav className="vending-section-nav" aria-label="垢生成の管理メニュー">
          {tabs.map(t => (
            <button
              key={t.key}
              type="button"
              aria-pressed={activeTab === t.key}
              onClick={() => setActiveTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </section>

      {activeTab === "status" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>ステータス</h3>
              <p className="muted">現在保有しているアカウントの内訳と、生成ジョブの稼働状況です。</p>
            </div>
            <button type="button" className="secondary" onClick={loadStatus} disabled={statusLoading}>
              {statusLoading ? "更新中…" : "更新"}
            </button>
          </div>
          {statusFeedback && <div className="alert error">{statusFeedback.message}</div>}
          {status && (
            <>
              <div className="metric-grid">
                {[
                  { label: "合計", value: status.total },
                  { label: "CLEAN", value: status.by_status["clean"] ?? 0 },
                  { label: "WARMING", value: status.by_status["warming"] ?? 0 },
                  { label: "CREATED", value: status.by_status["created"] ?? 0 },
                  { label: "SHADOW", value: (status.by_status["soft_shadow"] ?? 0) + (status.by_status["hard_shadow"] ?? 0) },
                  { label: "SOLD", value: status.by_status["sold"] ?? 0 }
                ].map(s => (
                  <article className="metric card" key={s.label}>
                    <span>{s.label}</span>
                    <strong>{s.value}</strong>
                  </article>
                ))}
              </div>
              <span className={`status-pill ${status.orchestrator_running ? "good" : ""}`}>
                <i />
                オーケストレーター: {status.orchestrator_running ? `実行中（目標 ${status.orchestrator_target} 垢）` : "停止中"}
              </span>
            </>
          )}
        </section>
      )}

      {activeTab === "inventory" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>在庫</h3>
              <p className="muted">状態ごとのアカウント件数です。</p>
            </div>
            <button type="button" className="secondary" onClick={loadInventory} disabled={inventoryLoading}>
              {inventoryLoading ? "更新中…" : "更新"}
            </button>
          </div>
          {inventory && (
            <div className="smm-table-wrap">
              <table className="smm-table">
                <thead>
                  <tr>
                    <th>ステータス</th>
                    <th>件数</th>
                  </tr>
                </thead>
                <tbody>
                  {(["clean", "warming", "created", "soft_shadow", "hard_shadow", "locked", "suspended", "sold"] as const).map(s => (
                    <tr key={s}>
                      <td><StatusBadge status={s} /></td>
                      <td>{inventory[s] ?? 0}</td>
                    </tr>
                  ))}
                  <tr>
                    <td><strong>合計</strong></td>
                    <td><strong>{inventory.total}</strong></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {activeTab === "accounts" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>アカウント一覧</h3>
              <p className="muted">ステータスで絞り込んで確認できます。</p>
            </div>
          </div>
          <div className="form-grid two">
            <label className="field">
              <span>ステータス</span>
              <select value={accountFilter} onChange={e => setAccountFilter(e.target.value)}>
                <option value="">全ステータス</option>
                {["created", "warming", "clean", "soft_shadow", "hard_shadow", "locked", "suspended", "sold"].map(s => (
                  <option key={s} value={s}>{STATUS_LABEL[s] ?? s}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="button-row">
            <button type="button" className="primary" onClick={loadAccounts} disabled={accountsLoading}>
              {accountsLoading ? "検索中…" : "検索"}
            </button>
          </div>
          {accountsFeedback && <div className="alert error">{accountsFeedback.message}</div>}
          {accounts.length > 0 && (
            <div className="smm-table-wrap">
              <table className="smm-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>ユーザー名</th>
                    <th>ステータス</th>
                    <th>シャドウスコア</th>
                    <th>作成日時</th>
                    <th>最終操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(a => (
                    <tr key={a.id}>
                      <td>{a.id}</td>
                      <td>{a.username}</td>
                      <td><StatusBadge status={a.status} /></td>
                      <td>{a.shadow_score.toFixed(2)}</td>
                      <td>{a.created_at ? new Date(a.created_at).toLocaleString("ja-JP") : "—"}</td>
                      <td>{a.last_action_at ? new Date(a.last_action_at).toLocaleString("ja-JP") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {accounts.length === 0 && !accountsLoading && <p className="muted">「検索」を押してアカウントを表示してください。</p>}
        </section>
      )}

      {activeTab === "generate" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>垢生成</h3>
              <p className="muted">プロキシ・SMS・Captchaの設定に沿ってアカウントを生成します。</p>
            </div>
          </div>

          {config && (
            <details>
              <summary>現在の設定</summary>
              <div className="list-stack">
                <div className="serverless-note">
                  <strong>プロキシ</strong>
                  <span>{config.proxy.provider} — {config.proxy.host}:{config.proxy.port}（{config.proxy.country}）</span>
                </div>
                <div className="serverless-note">
                  <strong>SMS</strong>
                  <span>{config.sms.provider} — {config.sms.preferred_countries.join(", ")}</span>
                </div>
                <div className="serverless-note">
                  <strong>Captcha</strong>
                  <span>{config.captcha.provider}{config.captcha.provider_fallback ? " / " + config.captcha.provider_fallback : ""}</span>
                </div>
                <div className="serverless-note">
                  <strong>生成上限</strong>
                  <span>{config.factory.max_per_hour} 垢/時間 ・ 電話認証 {config.factory.use_phone ? "有効" : "無効"}</span>
                </div>
                <div className="serverless-note">
                  <strong>ウォームアップ</strong>
                  <span>{config.warmup.min_days_before_sale} 日以上 ・ {config.warmup.actions_per_day_soft} アクション/日</span>
                </div>
              </div>
            </details>
          )}
          {configFeedback && <div className="alert error">{configFeedback.message}</div>}

          <div className="form-grid two">
            <label className="field">
              <span>生成数</span>
              <input type="number" min={1} max={100} value={genCount} onChange={e => setGenCount(e.target.value)} />
            </label>
            <label className="field">
              <span>同時実行数</span>
              <input type="number" min={1} max={10} value={genConcurrency} onChange={e => setGenConcurrency(e.target.value)} />
            </label>
          </div>
          <div className="button-row">
            <button
              type="button"
              className="primary"
              onClick={handleGenerate}
              disabled={genBusy || (status?.orchestrator_running ?? false)}
            >
              {genBusy ? "開始中…" : status?.orchestrator_running ? "実行中" : "垢生成を開始"}
            </button>
          </div>
          {genFeedback && (
            <div className={genFeedback.kind === "error" ? "alert error" : "alert success"}>{genFeedback.message}</div>
          )}
        </section>
      )}

      {activeTab === "push" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>仕入れbotに追加</h3>
              <p className="muted">
                CLEANなアカウントをジェネレーターから取り出し、仕入れbot（Discord-Shiire）のサプライヤープールへ一度だけ追加します。
                自販機Botの商品を継続的に自動補充したい場合は「自動補充」タブを使ってください。
              </p>
            </div>
          </div>

          <div className="form-grid two">
            <label className="field">
              <span>サプライヤーID</span>
              <input value={pushSupplierId} onChange={e => setPushSupplierId(e.target.value)} placeholder="supplier_xxxx" />
            </label>
            <label className="field">
              <span>SKU</span>
              <input value={pushSku} onChange={e => setPushSku(e.target.value)} placeholder="x_account_clean" />
            </label>
            <label className="field">
              <span>件数</span>
              <input type="number" min={1} max={200} value={pushCount} onChange={e => setPushCount(e.target.value)} />
            </label>
            <label className="field">
              <span>最低ウォームアップ日数</span>
              <input type="number" min={0} value={pushMinDays} onChange={e => setPushMinDays(e.target.value)} />
            </label>
          </div>

          <label className="toggle-row">
            <span className="toggle-copy">
              <strong>SOFT_SHADOWも含める</strong>
              <small>CLEANだけで足りない場合に、軽いシャドウバン疑いのアカウントも対象にします。</small>
            </span>
            <span className={`switch ${pushAllowSoft ? "on" : ""}`}>
              <input type="checkbox" checked={pushAllowSoft} onChange={e => setPushAllowSoft(e.target.checked)} />
              <span />
            </span>
          </label>

          <div className="button-row">
            <button type="button" className="primary" onClick={handlePush} disabled={pushBusy}>
              {pushBusy ? "追加中…" : "自販機に追加"}
            </button>
          </div>
          {pushFeedback && (
            <div className={pushFeedback.kind === "error" ? "alert error" : "alert success"}>{pushFeedback.message}</div>
          )}
        </section>
      )}

      {activeTab === "restock" && (
        <>
          <section className="card">
            <div className="section-head">
              <div>
                <h3>自動補充を設定</h3>
                <p className="muted">
                  すでに設置してある自販機Botの自販機・商品を選び、在庫が減ったら自動でジェネレーターから補充するルールを作ります。
                  仕入れbot（Discord-Shiire）の自販機は、現時点ではこの自動補充に対応していません。
                </p>
              </div>
            </div>

            <div className="form-grid two">
              <label className="field">
                <span>自販機</span>
                <select value={restockMachineId} onChange={e => setRestockMachineId(e.target.value)}>
                  <option value="">選択してください</option>
                  {restockMachines.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>商品</span>
                <select value={restockProductId} onChange={e => setRestockProductId(e.target.value)} disabled={!restockMachineDetail}>
                  <option value="">選択してください</option>
                  {(restockMachineDetail?.products ?? []).map(p => (
                    <option key={p.id} value={p.id} disabled={Boolean(p.infinite_stock)}>
                      {p.name}{p.infinite_stock ? "（無限在庫のため対象外）" : "（在庫 " + p.stock_count + "）"}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>最低在庫数</span>
                <input type="number" min={0} value={restockMinStock} onChange={e => setRestockMinStock(e.target.value)} />
                <small>在庫がこの数を下回ったら補充します。</small>
              </label>
              <label className="field">
                <span>目標在庫数</span>
                <input type="number" min={0} value={restockTargetStock} onChange={e => setRestockTargetStock(e.target.value)} />
                <small>この数まで補充します。</small>
              </label>
              <label className="field">
                <span>1回あたりの補充上限</span>
                <input type="number" min={1} max={200} value={restockMaxBatch} onChange={e => setRestockMaxBatch(e.target.value)} />
                <small>1回の実行でジェネレーターから取り出す最大件数です。</small>
              </label>
            </div>
            <div className="button-row">
              <button type="button" className="primary" onClick={handleCreateRestockRule} disabled={restockBusy}>
                {restockBusy ? "作成中…" : "自動補充ルールを作成"}
              </button>
            </div>
            {restockFeedback && (
              <div className={restockFeedback.kind === "error" ? "alert error" : "alert success"}>{restockFeedback.message}</div>
            )}
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <h3>設定済みの自動補充ルール</h3>
                <p className="muted">1分ごとに在庫を確認し、最低在庫数を下回っていれば自動で補充します。</p>
              </div>
              <button type="button" className="secondary" onClick={loadRestockRules} disabled={restockLoading}>
                {restockLoading ? "更新中…" : "更新"}
              </button>
            </div>
            <div className="list-stack">
              {restockRules.map(rule => (
                <div className="serverless-note" key={rule.id}>
                  <strong>{rule.machineName ?? rule.vendingMachineId} — {rule.productName ?? rule.productId}</strong>
                  <span>
                    最低 {rule.minStock} / 目標 {rule.targetStock} / 1回最大 {rule.maxBatch} ・
                    {rule.enabled ? "有効" : "無効"} ・
                    {rule.lastRunAt ? "最終確認 " + new Date(rule.lastRunAt).toLocaleString("ja-JP") : "未実行"}
                    {rule.lastAdded > 0 ? "（前回 " + rule.lastAdded + " 垢補充）" : ""}
                    {rule.lastError ? " ・ エラー: " + rule.lastError : ""}
                  </span>
                  <div className="button-row">
                    <button type="button" className="secondary" onClick={() => runRestockNow(rule)} disabled={restockBusy}>
                      今すぐ補充
                    </button>
                    <button type="button" className="secondary" onClick={() => toggleRestockRule(rule)} disabled={restockBusy}>
                      {rule.enabled ? "無効にする" : "有効にする"}
                    </button>
                    <button type="button" className="danger" onClick={() => deleteRestockRule(rule)} disabled={restockBusy}>
                      削除
                    </button>
                  </div>
                </div>
              ))}
              {restockRules.length === 0 && !restockLoading && <p className="muted">まだ自動補充ルールがありません。</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
