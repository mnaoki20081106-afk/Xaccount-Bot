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

type ActiveTab = "status" | "inventory" | "accounts" | "generate" | "push";

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
  const [configLoading, setConfigLoading] = useState(false);
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

  const base = "/api/guilds/" + guildId + "/generator";

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
    setConfigLoading(true);
    setConfigFeedback(null);
    api<ConfigData>(base + "/config")
      .then(data => setConfig(data))
      .catch(err => setConfigFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setConfigLoading(false));
  }, [base]);

  useEffect(() => {
    if (activeTab === "status") loadStatus();
    if (activeTab === "inventory") loadInventory();
    if (activeTab === "accounts") loadAccounts();
    if (activeTab === "generate") { loadStatus(); loadConfig(); }
  }, [activeTab]);

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

  const statusBadge = (s: string) => {
    const colors: Record<string, string> = {
      clean: "#22c55e",
      warming: "#f59e0b",
      created: "#94a3b8",
      soft_shadow: "#f97316",
      hard_shadow: "#ef4444",
      locked: "#dc2626",
      suspended: "#7f1d1d",
      sold: "#64748b"
    };
    return (
      <span style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 600,
        background: colors[s] ?? "#6b7280",
        color: "#fff"
      }}>{s}</span>
    );
  };

  const tabs: { key: ActiveTab; label: string }[] = [
    { key: "status", label: "ステータス" },
    { key: "inventory", label: "在庫" },
    { key: "accounts", label: "アカウント一覧" },
    { key: "generate", label: "垢生成" },
    { key: "push", label: "自販機に追加" }
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>垢生成管理</h2>

      <nav style={{ display: "flex", gap: 4, borderBottom: "1px solid var(--border-color, #e2e8f0)", flexWrap: "wrap" }}>
        {tabs.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActiveTab(t.key)}
            style={{
              padding: "6px 14px",
              border: "none",
              borderBottom: activeTab === t.key ? "2px solid currentColor" : "2px solid transparent",
              background: "transparent",
              cursor: "pointer",
              fontWeight: activeTab === t.key ? 600 : 400,
              opacity: activeTab === t.key ? 1 : 0.6,
              fontSize: 14
            }}
          >{t.label}</button>
        ))}
      </nav>

      {activeTab === "status" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" onClick={loadStatus} disabled={statusLoading} className="btn">
              {statusLoading ? "読み込み中…" : "更新"}
            </button>
          </div>
          {statusFeedback && (
            <p style={{ color: statusFeedback.kind === "error" ? "var(--error-color, #ef4444)" : "inherit" }}>
              {statusFeedback.message}
            </p>
          )}
          {status && (
            <>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {[
                  { label: "合計", value: status.total, color: "#6366f1" },
                  { label: "CLEAN", value: status.by_status["clean"] ?? 0, color: "#22c55e" },
                  { label: "WARMING", value: status.by_status["warming"] ?? 0, color: "#f59e0b" },
                  { label: "CREATED", value: status.by_status["created"] ?? 0, color: "#94a3b8" },
                  { label: "SHADOW", value: (status.by_status["soft_shadow"] ?? 0) + (status.by_status["hard_shadow"] ?? 0), color: "#ef4444" },
                  { label: "SOLD", value: status.by_status["sold"] ?? 0, color: "#64748b" }
                ].map(s => (
                  <div key={s.label} style={{
                    background: "var(--card-bg, #f8fafc)",
                    border: "1px solid var(--border-color, #e2e8f0)",
                    borderRadius: 8,
                    padding: "12px 18px",
                    minWidth: 80,
                    textAlign: "center"
                  }}>
                    <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
                    <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>{s.label}</div>
                  </div>
                ))}
              </div>
              <div style={{
                padding: "10px 14px",
                borderRadius: 8,
                background: status.orchestrator_running ? "rgba(34,197,94,0.1)" : "rgba(148,163,184,0.1)",
                border: "1px solid " + (status.orchestrator_running ? "rgba(34,197,94,0.3)" : "rgba(148,163,184,0.3)"),
                fontSize: 13
              }}>
                オーケストレーター:{" "}
                <strong>{status.orchestrator_running ? "実行中 (目標: " + status.orchestrator_target + " 垢)" : "停止中"}</strong>
              </div>
            </>
          )}
        </div>
      )}

      {activeTab === "inventory" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <button type="button" onClick={loadInventory} disabled={inventoryLoading} className="btn">
            {inventoryLoading ? "読み込み中…" : "更新"}
          </button>
          {inventory && (
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid var(--border-color, #e2e8f0)", textAlign: "left" }}>
                  <th style={{ padding: "6px 10px" }}>ステータス</th>
                  <th style={{ padding: "6px 10px", textAlign: "right" }}>件数</th>
                </tr>
              </thead>
              <tbody>
                {(["clean","warming","created","soft_shadow","hard_shadow","locked","suspended","sold"] as const).map(s => (
                  <tr key={s} style={{ borderBottom: "1px solid var(--border-color, #e2e8f0)" }}>
                    <td style={{ padding: "6px 10px" }}>{statusBadge(s)}</td>
                    <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 600 }}>
                      {inventory[s] ?? 0}
                    </td>
                  </tr>
                ))}
                <tr style={{ borderTop: "2px solid var(--border-color, #e2e8f0)", fontWeight: 700 }}>
                  <td style={{ padding: "6px 10px" }}>合計</td>
                  <td style={{ padding: "6px 10px", textAlign: "right" }}>{inventory.total}</td>
                </tr>
              </tbody>
            </table>
          )}
        </div>
      )}

      {activeTab === "accounts" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={accountFilter}
              onChange={e => setAccountFilter(e.target.value)}
              style={{ padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", fontSize: 13 }}
            >
              <option value="">全ステータス</option>
              {["created","warming","clean","soft_shadow","hard_shadow","locked","suspended","sold"].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <button type="button" onClick={loadAccounts} disabled={accountsLoading} className="btn">
              {accountsLoading ? "読み込み中…" : "検索"}
            </button>
          </div>
          {accountsFeedback && (
            <p style={{ color: "var(--error-color, #ef4444)" }}>{accountsFeedback.message}</p>
          )}
          {accounts.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--border-color, #e2e8f0)", textAlign: "left" }}>
                    <th style={{ padding: "5px 8px" }}>ID</th>
                    <th style={{ padding: "5px 8px" }}>ユーザー名</th>
                    <th style={{ padding: "5px 8px" }}>ステータス</th>
                    <th style={{ padding: "5px 8px", textAlign: "right" }}>シャドウスコア</th>
                    <th style={{ padding: "5px 8px" }}>作成日時</th>
                    <th style={{ padding: "5px 8px" }}>最終操作</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map(a => (
                    <tr key={a.id} style={{ borderBottom: "1px solid var(--border-color, #e2e8f0)" }}>
                      <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{a.id}</td>
                      <td style={{ padding: "5px 8px", fontFamily: "monospace" }}>{a.username}</td>
                      <td style={{ padding: "5px 8px" }}>{statusBadge(a.status)}</td>
                      <td style={{ padding: "5px 8px", textAlign: "right", fontFamily: "monospace" }}>
                        {a.shadow_score.toFixed(2)}
                      </td>
                      <td style={{ padding: "5px 8px", fontSize: 11, opacity: 0.7 }}>
                        {a.created_at ? new Date(a.created_at).toLocaleString("ja-JP") : "-"}
                      </td>
                      <td style={{ padding: "5px 8px", fontSize: 11, opacity: 0.7 }}>
                        {a.last_action_at ? new Date(a.last_action_at).toLocaleString("ja-JP") : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {accounts.length === 0 && !accountsLoading && (
            <p style={{ opacity: 0.5, fontSize: 13 }}>「検索」を押してアカウントを表示してください。</p>
          )}
        </div>
      )}

      {activeTab === "generate" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {config && (
            <details open>
              <summary style={{ cursor: "pointer", fontWeight: 600, marginBottom: 8 }}>現在の設定</summary>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13, paddingLeft: 12 }}>
                <div><strong>プロキシ:</strong> {config.proxy.provider} — {config.proxy.host}:{config.proxy.port} ({config.proxy.country})</div>
                <div><strong>SMS:</strong> {config.sms.provider} — {config.sms.preferred_countries.join(", ")}</div>
                <div><strong>Captcha:</strong> {config.captcha.provider}{config.captcha.provider_fallback ? " / " + config.captcha.provider_fallback : ""}</div>
                <div><strong>上限:</strong> {config.factory.max_per_hour} 垢/時間、電話認証: {config.factory.use_phone ? "有効" : "無効"}</div>
                <div><strong>ウォームアップ:</strong> {config.warmup.min_days_before_sale} 日以上 / {config.warmup.actions_per_day_soft} アクション/日</div>
              </div>
            </details>
          )}
          {configFeedback && (
            <p style={{ color: "var(--error-color, #ef4444)", fontSize: 13 }}>{configFeedback.message}</p>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 380 }}>
            <label style={{ fontSize: 14, fontWeight: 600 }}>垢生成</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ fontSize: 13, minWidth: 60 }}>生成数</label>
              <input
                type="number"
                value={genCount}
                onChange={e => setGenCount(e.target.value)}
                min={1} max={100}
                style={{ width: 80, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", fontSize: 13 }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ fontSize: 13, minWidth: 60 }}>同時数</label>
              <input
                type="number"
                value={genConcurrency}
                onChange={e => setGenConcurrency(e.target.value)}
                min={1} max={10}
                style={{ width: 80, padding: "4px 8px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", fontSize: 13 }}
              />
            </div>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={genBusy || (status?.orchestrator_running ?? false)}
              className="btn btn-primary"
              style={{ alignSelf: "flex-start" }}
            >
              {genBusy ? "開始中…" : status?.orchestrator_running ? "実行中" : "垢生成を開始"}
            </button>
          </div>
          {genFeedback && (
            <p style={{
              color: genFeedback.kind === "error" ? "var(--error-color, #ef4444)" : "var(--success-color, #22c55e)",
              fontSize: 13
            }}>{genFeedback.message}</p>
          )}
        </div>
      )}

      {activeTab === "push" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 440 }}>
          <p style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>
            Generatorの CLEAN 垢を取り出し、Discord-Shiire の自販機サプライヤープールに追加します。
          </p>

          {[
            { label: "サプライヤーID", value: pushSupplierId, set: setPushSupplierId, placeholder: "supplier_xxxx" },
            { label: "SKU", value: pushSku, set: setPushSku, placeholder: "x_account_clean" }
          ].map(f => (
            <div key={f.label} style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <label style={{ fontSize: 13, minWidth: 130 }}>{f.label}</label>
              <input
                type="text"
                value={f.value}
                onChange={e => f.set(e.target.value)}
                placeholder={f.placeholder}
                style={{ flex: 1, padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", fontSize: 13, fontFamily: "monospace" }}
              />
            </div>
          ))}

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ fontSize: 13, minWidth: 130 }}>件数</label>
            <input
              type="number"
              value={pushCount}
              onChange={e => setPushCount(e.target.value)}
              min={1} max={200}
              style={{ width: 80, padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", fontSize: 13 }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <label style={{ fontSize: 13, minWidth: 130 }}>最低ウォームアップ日数</label>
            <input
              type="number"
              value={pushMinDays}
              onChange={e => setPushMinDays(e.target.value)}
              min={0}
              style={{ width: 80, padding: "5px 10px", borderRadius: 6, border: "1px solid var(--border-color, #e2e8f0)", fontSize: 13 }}
            />
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={pushAllowSoft}
              onChange={e => setPushAllowSoft(e.target.checked)}
            />
            SOFT_SHADOW も含める
          </label>

          <button
            type="button"
            onClick={handlePush}
            disabled={pushBusy}
            className="btn btn-primary"
            style={{ alignSelf: "flex-start" }}
          >
            {pushBusy ? "追加中…" : "自販機に追加"}
          </button>

          {pushFeedback && (
            <p style={{
              color: pushFeedback.kind === "error" ? "var(--error-color, #ef4444)" : "var(--success-color, #22c55e)",
              fontSize: 13
            }}>{pushFeedback.message}</p>
          )}
        </div>
      )}
    </div>
  );
}
