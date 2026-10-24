import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type Props = {
  guildId: string;
  channels: Array<{ id: string; name: string; type?: string; botCanPost?: boolean }>;
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
  proxy: { provider: string; host: string; port: number; country: string; sticky_ttl_minutes: number; session_lifetime_minutes?: number; max_accounts_per_ip: number };
  sms: { provider: string; preferred_countries: string[] };
  captcha: { provider: string; provider_fallback: string };
  factory: { max_per_hour: number; use_phone: boolean; setup_profile: boolean };
  warmup: { min_days_before_sale: number; actions_per_day_soft: number };
};

type ObserverRow = {
  id: number;
  label: string;
  status: "unverified" | "ok" | "invalid" | "suspended" | "locked";
  last_error: string | null;
  last_checked_at: string | null;
  last_used_at: string | null;
  created_at: string;
};

type GraduationRow = {
  id: number;
  username: string;
  passed: boolean;
  attempts: number;
  checked_at: string | null;
  report: { stage: string; checks: Array<{ name: string; status: "pass" | "fail" | "unknown"; detail: string }> } | null;
};

const OBSERVER_STATUS_LABEL: Record<ObserverRow["status"], string> = {
  ok: "使用可",
  unverified: "未確認",
  invalid: "無効（トークン失効）",
  suspended: "凍結",
  locked: "ロック"
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

type ActiveTab = "status" | "inventory" | "accounts" | "generate" | "push" | "restock" | "perks" | "proxy" | "graduation" | "server" | "cost";

type CostWindow = {
  key: string;
  label: string;
  costs: { proxy: number; sms: number; captcha: number; email: number; other: number; vps: number; total: number };
  accounts: { created: number; alive: number; ready: number; failed: number };
  yield_rate: number | null;
  unit_cost: { per_alive: number | null; per_ready: number | null; per_created: number | null };
  unit_breakdown: Record<string, number | null> | null;
};

type VpsContract = {
  configured: boolean;
  label: string;
  provider: string;
  monthly_fee_jpy: number;
  billing_day: number | null;
  started_at: string | null;
  note: string | null;
  next_due: string | null;
};

type CostData = {
  generated_at: string;
  windows: CostWindow[];
  proxy: { payments: number; total_paid_jpy: number; total_gb: number; avg_jpy_per_gb: number | null; last_paid_at: string | null };
  vps: VpsContract;
};

type ExpenseRow = {
  id: number;
  category: string;
  description: string;
  amount_jpy: number;
  currency: string;
  amount_original: number;
  rate_to_jpy: number;
  quantity: number | null;
  unit: string | null;
  paid_at: string;
  note: string | null;
};

const EXPENSE_CATEGORY_LABEL: Record<string, string> = {
  proxy: "プロキシ（通信量）",
  sms: "SMS認証",
  captcha: "Captcha",
  email: "メール",
  other: "その他"
};

const COST_PART_LABEL: Record<string, string> = {
  proxy: "プロキシ",
  sms: "SMS",
  captcha: "Captcha",
  email: "メール",
  other: "その他",
  vps: "VPS"
};

function formatYen(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return "¥" + Math.round(value).toLocaleString("ja-JP");
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return now.getFullYear() + "-" + month + "-" + day;
}

type ProxySessionRow = {
  session_id: string;
  state: "ready" | "cooling" | "circuit_open" | "full";
  account_count: number;
  max_accounts: number;
  assigned_accounts: number;
  consecutive_failures: number;
  cooldown_until: string | null;
  circuit_open_until: string | null;
  last_signup_at: string | null;
  last_exit_ip: string | null;
};

type ProxyData = {
  config: { provider: string; host: string; port: number; country: string; sticky_ttl_minutes: number; max_accounts_per_ip: number };
  summary: { total_sessions: number; cooling: number; circuit_open: number; ready: number };
  sessions: ProxySessionRow[];
  health_check: {
    running: boolean;
    started_at: number | null;
    finished_at: number | null;
    result: { checked?: number; healthy?: number; unhealthy?: number; error?: string } | null;
  };
};

type ServerInfo = {
  hostname: string;
  platform: string;
  python: string;
  cpu_count: number | null;
  load_average: number[] | null;
  memory: { total: number; available: number; used: number } | null;
  disk: { total: number; used: number; free: number } | null;
  host_uptime_seconds: number | null;
  api_uptime_seconds: number;
  db_size_bytes: number | null;
  log_size_bytes: number | null;
  orchestrator_running: boolean;
};

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  return size.toFixed(unit === 0 ? 0 : 1) + " " + units[unit];
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return days + "日 " + hours + "時間";
  if (hours > 0) return hours + "時間 " + minutes + "分";
  return minutes + "分";
}

function formatPercent(used: number, total: number): string {
  return total > 0 ? Math.round((used / total) * 100) + "%" : "—";
}

const PROXY_STATE_LABEL: Record<ProxySessionRow["state"], string> = {
  ready: "利用可能",
  cooling: "クーリング中",
  circuit_open: "遮断中",
  full: "上限到達"
};
const PROXY_STATE_TONE: Record<ProxySessionRow["state"], "good" | "warn" | "bad"> = {
  ready: "good",
  cooling: "warn",
  circuit_open: "bad",
  full: "warn"
};

type RestockSystem = "vending" | "shiire";
type PoolSystem = "invite" | "giveaway";

const TARGET_SYSTEM_LABEL: Record<string, string> = {
  vending: "自販機Bot",
  shiire: "仕入れBot",
  invite: "招待キャンペーン",
  giveaway: "無料配布"
};

type GiveawayOverview = {
  enabled: boolean;
  burstLimit: number;
  burstWindowMinutes: number;
  blocked: Array<{ user_id: string; reason: string | null; created_at: number }>;
  stockCount: number;
  reservedCount: number;
  claims: Record<string, number>;
  recent: Array<{ user_id: string; status: string; error: string | null; attempts: number; updated_at: number; delivered_at: number | null }>;
};

type PendingDelivery = {
  id: string;
  targetSystem: string;
  productId: string;
  count: number;
  attempts: number;
  lastError: string | null;
  createdAt: number;
};

type PoolForm = { assignCount: string; warmupDays: string; minStock: string; targetStock: string; maxBatch: string };
const DEFAULT_POOL_FORM: PoolForm = { assignCount: "5", warmupDays: "0", minStock: "5", targetStock: "20", maxBatch: "10" };

type VendingMachineRow = { id: string; name: string };
// infinite_stock only exists on 自販機Bot products; 仕入れBot products are always finite.
type VendingProductRow = { id: string; name: string; infinite_stock?: number; stock_count: number };
type VendingMachineDetail = VendingMachineRow & { products: VendingProductRow[] };

type RestockRule = {
  id: string;
  targetSystem: RestockSystem | PoolSystem;
  vendingMachineId: string;
  machineName: string | null;
  productId: string;
  productName: string | null;
  minStock: number;
  targetStock: number;
  maxBatch: number;
  minWarmupDays: number;
  enabled: boolean;
  pendingDelivery: boolean;
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

export default function XGeneratorManager({ guildId, channels, onNotice, onError }: Props) {
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

  const [restockSystem, setRestockSystem] = useState<RestockSystem>("vending");
  const [restockWarmupDays, setRestockWarmupDays] = useState("0");
  const [restockMachines, setRestockMachines] = useState<VendingMachineDetail[]>([]);
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

  const [proxy, setProxy] = useState<ProxyData | null>(null);
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyBusy, setProxyBusy] = useState(false);
  const [proxyFeedback, setProxyFeedback] = useState<Feedback | null>(null);
  const [observers, setObservers] = useState<ObserverRow[]>([]);
  const [graduation, setGraduation] = useState<{ graduated: number; accounts: GraduationRow[] } | null>(null);
  const [obsLabel, setObsLabel] = useState("");
  const [obsAuthToken, setObsAuthToken] = useState("");
  const [obsCt0, setObsCt0] = useState("");
  const [obsBusy, setObsBusy] = useState(false);
  const [obsFeedback, setObsFeedback] = useState<Feedback | null>(null);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverFeedback, setServerFeedback] = useState<Feedback | null>(null);

  const [costs, setCosts] = useState<CostData | null>(null);
  const [costsLoading, setCostsLoading] = useState(false);
  const [costsFeedback, setCostsFeedback] = useState<Feedback | null>(null);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [expenseCategory, setExpenseCategory] = useState("proxy");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseCurrency, setExpenseCurrency] = useState("JPY");
  const [expenseRate, setExpenseRate] = useState("");
  const [expenseQuantity, setExpenseQuantity] = useState("");
  const [expensePaidAt, setExpensePaidAt] = useState(todayIso());
  const [expenseNote, setExpenseNote] = useState("");
  const [expenseBusy, setExpenseBusy] = useState(false);
  const [expenseFeedback, setExpenseFeedback] = useState<Feedback | null>(null);

  const [vpsLabel, setVpsLabel] = useState("");
  const [vpsProvider, setVpsProvider] = useState("");
  const [vpsFee, setVpsFee] = useState("");
  const [vpsBillingDay, setVpsBillingDay] = useState("");
  const [vpsStartedAt, setVpsStartedAt] = useState("");
  const [vpsNote, setVpsNote] = useState("");
  const [vpsBusy, setVpsBusy] = useState(false);
  const [vpsFeedback, setVpsFeedback] = useState<Feedback | null>(null);

  const [logLines, setLogLines] = useState<string[] | null>(null);
  const [logAvailable, setLogAvailable] = useState(true);
  const [logLevel, setLogLevel] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const [logFeedback, setLogFeedback] = useState<Feedback | null>(null);
  const [stopBusy, setStopBusy] = useState(false);

  const [giveaway, setGiveaway] = useState<GiveawayOverview | null>(null);
  const [inviteStock, setInviteStock] = useState<number | null>(null);
  const [pending, setPending] = useState<PendingDelivery[]>([]);
  const [perksLoading, setPerksLoading] = useState(false);
  const [perksBusy, setPerksBusy] = useState(false);
  const [perksFeedback, setPerksFeedback] = useState<Feedback | null>(null);
  const [poolForms, setPoolForms] = useState<Record<PoolSystem, PoolForm>>({
    invite: { ...DEFAULT_POOL_FORM },
    giveaway: { ...DEFAULT_POOL_FORM, minStock: "3", targetStock: "10", maxBatch: "5" }
  });
  const base = "/api/guilds/" + guildId + "/generator";
  const vendingBase = "/api/guilds/" + guildId + "/vending";
  const shiireVendingBase = "/api/guilds/" + guildId + "/shiire/vending";

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
    // 仕入れBotの一覧は商品込みで返ってくる。自販機Botは一覧に商品が無いので、選択後に詳細を取得する。
    api<VendingMachineDetail[]>(restockSystem === "shiire" ? shiireVendingBase : vendingBase)
      .then(data => setRestockMachines(data))
      .catch(err => setRestockFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [restockSystem, vendingBase, shiireVendingBase]);

  const loadProxy = useCallback(() => {
    setProxyLoading(true);
    api<ProxyData>(base + "/proxy")
      .then(data => { setProxy(data); setProxyFeedback(null); })
      .catch(err => setProxyFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setProxyLoading(false));
  }, [base]);

  const loadGraduation = useCallback(() => {
    api<{ observers: ObserverRow[] }>(base + "/observers")
      .then(data => { setObservers(data.observers); setObsFeedback(null); })
      .catch(err => setObsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
    api<{ graduated: number; accounts: GraduationRow[] }>(base + "/graduation")
      .then(data => setGraduation(data))
      .catch(err => setObsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [base]);

  const saveObserver = () => {
    if (!obsAuthToken.trim() || !obsCt0.trim()) {
      setObsFeedback({ kind: "error", message: "auth_token と ct0 の両方を入力してください" });
      return;
    }
    setObsBusy(true);
    setObsFeedback({ kind: "info", message: "登録してトークンを検証しています…" });
    api<{ observer: ObserverRow }>(base + "/observers", {
      method: "POST",
      body: JSON.stringify({ label: obsLabel, auth_token: obsAuthToken, ct0: obsCt0 })
    })
      .then(data => {
        setObsAuthToken("");
        setObsCt0("");
        setObsLabel("");
        const ok = data.observer.status === "ok";
        setObsFeedback({
          kind: ok ? "success" : "error",
          message: ok
            ? "観測者を登録しました（検証OK）"
            : "登録しましたが検証に失敗しました: " + OBSERVER_STATUS_LABEL[data.observer.status]
        });
        loadGraduation();
      })
      .catch(err => setObsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setObsBusy(false));
  };

  const verifyObserver = (row: ObserverRow) => {
    setObsBusy(true);
    api(base + "/observers/" + row.id + "/verify", { method: "POST" })
      .then(() => loadGraduation())
      .catch(err => setObsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setObsBusy(false));
  };

  const deleteObserver = (row: ObserverRow) => {
    if (!window.confirm("観測者 #" + row.id + (row.label ? "（" + row.label + "）" : "") + " を削除します。よろしいですか？")) return;
    setObsBusy(true);
    api(base + "/observers/" + row.id, { method: "DELETE" })
      .then(() => { onNotice("観測者を削除しました"); loadGraduation(); })
      .catch(err => setObsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setObsBusy(false));
  };

  const loadCosts = useCallback(() => {
    setCostsLoading(true);
    api<CostData>(base + "/costs")
      .then(data => { setCosts(data); setCostsFeedback(null); })
      .catch(err => setCostsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setCostsLoading(false));
  }, [base]);

  const loadExpenses = useCallback(() => {
    api<{ expenses: ExpenseRow[] }>(base + "/expenses")
      .then(data => setExpenses(data.expenses))
      .catch(err => setCostsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [base]);

  const loadVpsContract = useCallback(() => {
    api<VpsContract>(base + "/vps-contract")
      .then(data => {
        setVpsLabel(data.label);
        setVpsProvider(data.provider);
        setVpsFee(data.configured ? String(data.monthly_fee_jpy) : "");
        setVpsBillingDay(data.billing_day ? String(data.billing_day) : "");
        setVpsStartedAt(data.started_at ?? "");
        setVpsNote(data.note ?? "");
      })
      .catch(err => setVpsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [base]);

  const loadLogs = useCallback((level: string) => {
    setLogLoading(true);
    const qs = "?lines=200" + (level ? "&level=" + encodeURIComponent(level) : "");
    api<{ available: boolean; lines: string[] }>(base + "/logs" + qs)
      .then(data => { setLogLines(data.lines); setLogAvailable(data.available); setLogFeedback(null); })
      .catch(err => setLogFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setLogLoading(false));
  }, [base]);

  const handleAddExpense = () => {
    const amount = Number(expenseAmount);
    const quantity = expenseQuantity.trim() === "" ? null : Number(expenseQuantity);
    if (!(amount > 0)) {
      setExpenseFeedback({ kind: "error", message: "金額を入力してください" });
      return;
    }
    if (expenseCurrency !== "JPY" && !(Number(expenseRate) > 0)) {
      setExpenseFeedback({ kind: "error", message: "円以外の通貨は、円への換算レートを入力してください" });
      return;
    }
    if (quantity !== null && !(quantity > 0)) {
      setExpenseFeedback({ kind: "error", message: "数量は0より大きい値で入力してください" });
      return;
    }
    setExpenseBusy(true);
    setExpenseFeedback(null);
    api(base + "/expenses", {
      method: "POST",
      body: JSON.stringify({
        category: expenseCategory,
        description: expenseDescription,
        amount,
        currency: expenseCurrency,
        rate_to_jpy: expenseCurrency === "JPY" ? null : Number(expenseRate),
        quantity,
        paid_at: expensePaidAt || null,
        note: expenseNote || null
      }),
      headers: { "Content-Type": "application/json" }
    })
      .then(() => {
        onNotice("支払いを記録しました");
        setExpenseDescription("");
        setExpenseAmount("");
        setExpenseQuantity("");
        setExpenseNote("");
        loadCosts();
        loadExpenses();
      })
      .catch(err => setExpenseFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setExpenseBusy(false));
  };

  const deleteExpense = (row: ExpenseRow) => {
    if (!confirm(row.paid_at + " の " + formatYen(row.amount_jpy) + "（" + (EXPENSE_CATEGORY_LABEL[row.category] ?? row.category) + "）の記録を削除しますか？")) return;
    setExpenseBusy(true);
    api(base + "/expenses/" + row.id, { method: "DELETE" })
      .then(() => { onNotice("支払いの記録を削除しました"); loadCosts(); loadExpenses(); })
      .catch(err => setExpenseFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setExpenseBusy(false));
  };

  const saveVpsContract = () => {
    const fee = Number(vpsFee || 0);
    const day = vpsBillingDay.trim() === "" ? null : Number(vpsBillingDay);
    if (!(fee >= 0)) {
      setVpsFeedback({ kind: "error", message: "月額は0以上で入力してください" });
      return;
    }
    if (day !== null && !(Number.isInteger(day) && day >= 1 && day <= 31)) {
      setVpsFeedback({ kind: "error", message: "支払日は1〜31で入力してください" });
      return;
    }
    setVpsBusy(true);
    setVpsFeedback(null);
    api<VpsContract>(base + "/vps-contract", {
      method: "PUT",
      body: JSON.stringify({
        label: vpsLabel,
        provider: vpsProvider,
        monthly_fee_jpy: fee,
        billing_day: day,
        started_at: vpsStartedAt || null,
        note: vpsNote || null
      }),
      headers: { "Content-Type": "application/json" }
    })
      .then(() => { onNotice("VPS契約を保存しました"); loadCosts(); })
      .catch(err => setVpsFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setVpsBusy(false));
  };

  const stopGeneration = () => {
    if (!confirm("実行中の垢生成を停止します。作成途中の垢は残りません。よろしいですか？")) return;
    setStopBusy(true);
    api(base + "/generate/stop", { method: "POST" })
      .then(() => { onNotice("垢生成の停止を要求しました"); window.setTimeout(loadStatus, 1500); })
      .catch(err => setGenFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setStopBusy(false));
  };

  const shiireBase = "/api/guilds/" + guildId + "/shiire";

  const loadPerks = useCallback(() => {
    setPerksLoading(true);
    Promise.all([
      api<GiveawayOverview>(shiireBase + "/free-giveaway"),
      api<{ stockCount: number }>(shiireBase + "/generator/pools/invite-campaign/stock"),
      api<{ pending: PendingDelivery[] }>(base + "/assign"),
      api<RestockRule[]>(base + "/restock-rules")
    ])
      .then(([overview, invite, pend, rules]) => {
        setGiveaway(overview);
        setInviteStock(invite.stockCount);
        setPending(pend.pending);
        setRestockRules(rules);
        setPerksFeedback(null);
      })
      .catch(err => setPerksFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setPerksLoading(false));
  }, [shiireBase, base]);

  const runPerksAction = (request: Promise<unknown>, successMessage: string) => {
    setPerksBusy(true);
    setPerksFeedback(null);
    request
      .then(() => { onNotice(successMessage); loadPerks(); })
      .catch(err => setPerksFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setPerksBusy(false));
  };

  const updatePoolForm = (system: PoolSystem, patch: Partial<PoolForm>) =>
    setPoolForms(current => ({ ...current, [system]: { ...current[system], ...patch } }));

  const assignToPool = (system: PoolSystem) => {
    const form = poolForms[system];
    const count = parseInt(form.assignCount, 10);
    if (!Number.isInteger(count) || count < 1 || count > 200) {
      setPerksFeedback({ kind: "error", message: "在庫追加数は1〜200で指定してください" });
      return;
    }
    runPerksAction(
      api(base + "/assign", {
        method: "POST",
        body: JSON.stringify({ targetSystem: system, count, minWarmupDays: parseInt(form.warmupDays, 10) || 0 }),
        headers: { "Content-Type": "application/json" }
      }),
      TARGET_SYSTEM_LABEL[system] + "の在庫に " + count + " 垢を割り当てました"
    );
  };

  const createPoolRule = (system: PoolSystem) => {
    const form = poolForms[system];
    const minStock = parseInt(form.minStock, 10);
    const targetStock = parseInt(form.targetStock, 10);
    const maxBatch = parseInt(form.maxBatch, 10);
    if (!Number.isInteger(minStock) || minStock < 0 || !Number.isInteger(targetStock) || targetStock < minStock || !Number.isInteger(maxBatch) || maxBatch < 1) {
      setPerksFeedback({ kind: "error", message: "最低在庫・目標在庫・補充上限を正しく入力してください" });
      return;
    }
    runPerksAction(
      api(base + "/restock-rules", {
        method: "POST",
        body: JSON.stringify({ targetSystem: system, minStock, targetStock, maxBatch, minWarmupDays: parseInt(form.warmupDays, 10) || 0 }),
        headers: { "Content-Type": "application/json" }
      }),
      TARGET_SYSTEM_LABEL[system] + "の自動補充を設定しました"
    );
  };

  const removePoolRule = (rule: RestockRule) => {
    if (!confirm(TARGET_SYSTEM_LABEL[rule.targetSystem] + "の自動補充を削除しますか？")) return;
    runPerksAction(api(base + "/restock-rules/" + rule.id, { method: "DELETE" }), "自動補充を削除しました");
  };

  const togglePoolRule = (rule: RestockRule) =>
    runPerksAction(
      api(base + "/restock-rules/" + rule.id, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !rule.enabled }),
        headers: { "Content-Type": "application/json" }
      }),
      rule.enabled ? "自動補充を無効にしました" : "自動補充を有効にしました"
    );

  const loadServerInfo = useCallback(() => {
    setServerLoading(true);
    api<ServerInfo>(base + "/server")
      .then(data => { setServerInfo(data); setServerFeedback(null); })
      .catch(err => setServerFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setServerLoading(false));
  }, [base]);

  const runProxyAction = (request: Promise<unknown>, successMessage: string) => {
    setProxyBusy(true);
    setProxyFeedback(null);
    request
      .then(() => { onNotice(successMessage); loadProxy(); })
      .catch(err => setProxyFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setProxyBusy(false));
  };

  const startProxyHealthCheck = () =>
    runProxyAction(api(base + "/proxy/health-check", { method: "POST" }), "プロキシのヘルスチェックを開始しました");

  const resetProxyCircuit = (row: ProxySessionRow) =>
    runProxyAction(
      api(base + "/proxy/sessions/" + row.session_id + "/reset", {
        method: "POST",
        body: JSON.stringify({ circuit: true, cooldown: false }),
        headers: { "Content-Type": "application/json" }
      }),
      "遮断を解除しました"
    );

  const resetProxyCooldown = (row: ProxySessionRow) => {
    if (!confirm("セッション " + row.session_id + " のクーリング（再利用待ち）を解除します。\n割当数も0に戻り、すぐ再利用されます。よろしいですか？")) return;
    runProxyAction(
      api(base + "/proxy/sessions/" + row.session_id + "/reset", {
        method: "POST",
        body: JSON.stringify({ circuit: true, cooldown: true }),
        headers: { "Content-Type": "application/json" }
      }),
      "クーリングを解除しました"
    );
  };

  const deleteProxySession = (row: ProxySessionRow) => {
    if (!confirm("セッション " + row.session_id + " を削除しますか？（垢が紐付いていない未使用のセッションです）")) return;
    runProxyAction(api(base + "/proxy/sessions/" + row.session_id, { method: "DELETE" }), "セッションを削除しました");
  };

  // ヘルスチェック中は3秒ごとに状態を取り直し、終わったら自然に止まる。
  const proxyHealthRunning = proxy?.health_check.running ?? false;
  useEffect(() => {
    if (activeTab !== "proxy" || !proxyHealthRunning) return;
    const timer = window.setTimeout(loadProxy, 3000);
    return () => window.clearTimeout(timer);
  }, [activeTab, proxyHealthRunning, proxy, loadProxy]);

  useEffect(() => {
    if (activeTab === "status") loadStatus();
    if (activeTab === "inventory") loadInventory();
    if (activeTab === "accounts") loadAccounts();
    if (activeTab === "generate") { loadStatus(); loadConfig(); }
    if (activeTab === "restock") loadRestockRules();
    if (activeTab === "proxy") loadProxy();
    if (activeTab === "graduation") loadGraduation();
    if (activeTab === "server") { loadServerInfo(); loadVpsContract(); loadLogs(logLevel); }
    if (activeTab === "cost") { loadCosts(); loadExpenses(); }
    if (activeTab === "perks") loadPerks();
    if (activeTab === "status") loadCosts();
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "restock") return;
    setRestockMachines([]);
    setRestockMachineId("");
    loadRestockMachines();
  }, [activeTab, restockSystem]);

  useEffect(() => {
    if (!restockMachineId) {
      setRestockMachineDetail(null);
      setRestockProductId("");
      return;
    }
    if (restockSystem === "shiire") {
      const detail = restockMachines.find(m => m.id === restockMachineId) ?? null;
      setRestockMachineDetail(detail);
      setRestockProductId(detail?.products[0]?.id ?? "");
      return;
    }
    api<VendingMachineDetail>(vendingBase + "/" + restockMachineId)
      .then(data => {
        setRestockMachineDetail(data);
        setRestockProductId(data.products.find(p => !p.infinite_stock)?.id ?? "");
      })
      .catch(err => setRestockFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }));
  }, [restockMachineId, restockSystem, restockMachines, vendingBase]);

  const handleCreateRestockRule = () => {
    const minStock = parseInt(restockMinStock, 10);
    const targetStock = parseInt(restockTargetStock, 10);
    const maxBatch = parseInt(restockMaxBatch, 10);
    const minWarmupDays = parseInt(restockWarmupDays, 10) || 0;
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
      body: JSON.stringify({ targetSystem: restockSystem, vendingMachineId: restockMachineId, productId: restockProductId, minStock, targetStock, maxBatch, minWarmupDays }),
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
      setPushFeedback({ kind: "error", message: "在庫追加数は 1〜200 で指定してください" });
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
    { key: "restock", label: "自動補充" },
    { key: "perks", label: "招待・無料配布" },
    { key: "proxy", label: "プロキシ" },
    { key: "graduation", label: "卒業テスト" },
    { key: "cost", label: "コスト・支払い" },
    { key: "server", label: "サーバー" }
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
          {costs && (() => {
            const win = costs.windows.find(w => w.key === "30d") ?? costs.windows[0];
            return win ? (
              <div className="x-generator-unit-cost">
                <article className="metric card">
                  <span>垢1つの単価（見込み・直近30日）</span>
                  <strong>{formatYen(win.unit_cost.per_alive)}</strong>
                  <small>生きている垢 {win.accounts.alive} 件あたり ・ 総コスト {formatYen(win.costs.total)}</small>
                </article>
                <article className="metric card">
                  <span>完成垢の単価（実績・直近30日）</span>
                  <strong>{formatYen(win.unit_cost.per_ready)}</strong>
                  <small>販売可能になった垢 {win.accounts.ready} 件あたり</small>
                </article>
              </div>
            ) : null;
          })()}
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
            {status?.orchestrator_running && (
              <button type="button" className="danger" onClick={stopGeneration} disabled={stopBusy}>
                {stopBusy ? "停止中…" : "生成を停止"}
              </button>
            )}
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
              <span>在庫追加数</span>
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
                  すでに設置してある自販機・商品を選び、在庫が減ったら自動でジェネレーターから補充するルールを作ります。
                  自販機Botと仕入れBotのどちらの自販機にも設定できます。
                </p>
              </div>
            </div>

            <div className="form-grid two">
              <label className="field">
                <span>対象のBot</span>
                <select value={restockSystem} onChange={e => setRestockSystem(e.target.value as RestockSystem)}>
                  <option value="vending">自販機Bot（自分で作る自販機）</option>
                  <option value="shiire">仕入れBot（仕入れ連動の自販機）</option>
                </select>
              </label>
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
              <label className="field">
                <span>最低ウォームアップ日数</span>
                <input type="number" min={0} max={365} value={restockWarmupDays} onChange={e => setRestockWarmupDays(e.target.value)} />
                <small>作成からこの日数以上たった垢だけを補充します。0なら制限しません。</small>
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
                  <strong>
                    [{TARGET_SYSTEM_LABEL[rule.targetSystem] ?? rule.targetSystem}] {rule.machineName ?? rule.vendingMachineId} — {rule.productName ?? rule.productId}
                  </strong>
                  <span>
                    最低 {rule.minStock} / 目標 {rule.targetStock} / 1回最大 {rule.maxBatch}
                    {rule.minWarmupDays > 0 ? " / ウォームアップ " + rule.minWarmupDays + "日以上" : ""} ・
                    {rule.pendingDelivery ? "納品待ちの垢あり（次回の確認で再納品します） ・" : ""}
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
      {activeTab === "graduation" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>卒業テスト・観測者</h3>
              <p className="muted">
                ウォームアップ完了後、別のXアカウント（観測者）から検索して「Top検索に本人のポストが出る」「検索候補に本人が出る」を確認し、
                両方通った垢だけを卒業とします。観測者はチェック専用のアカウントを推奨します。
                トークンは暗号化して保存し、保存後は画面にも返しません。
              </p>
            </div>
            <button type="button" className="secondary" onClick={loadGraduation}>更新</button>
          </div>

          <label className="field">
            <span>ラベル（任意）</span>
            <input value={obsLabel} maxLength={60} onChange={e => setObsLabel(e.target.value)} placeholder="例: 観測用1" />
          </label>
          <label className="field">
            <span>auth_token</span>
            <input type="password" value={obsAuthToken} autoComplete="off" onChange={e => setObsAuthToken(e.target.value)} placeholder="観測者の auth_token" />
          </label>
          <label className="field">
            <span>ct0</span>
            <input type="password" value={obsCt0} autoComplete="off" onChange={e => setObsCt0(e.target.value)} placeholder="観測者の ct0" />
          </label>
          <div className="button-row">
            <button type="button" className="primary" disabled={obsBusy} onClick={saveObserver}>
              {obsBusy ? "処理中…" : "観測者を登録して検証"}
            </button>
          </div>
          {obsFeedback && <div className={"alert " + (obsFeedback.kind === "error" ? "error" : obsFeedback.kind)}>{obsFeedback.message}</div>}

          <h4>登録済みの観測者</h4>
          {observers.length === 0 && (
            <p className="muted">観測者が未登録です。登録するまで卒業テストは「保留」のままで、合格しません。</p>
          )}
          {observers.map(o => (
            <div key={o.id} className="x-generator-row-head">
              <span>
                #{o.id} {o.label || "（ラベルなし）"} — <strong>{OBSERVER_STATUS_LABEL[o.status]}</strong>
                {o.last_checked_at && <> ・検証 {new Date(o.last_checked_at).toLocaleString("ja-JP")}</>}
                {o.last_error && <> ・{o.last_error}</>}
              </span>
              <span className="button-row">
                <button type="button" className="secondary" disabled={obsBusy} onClick={() => verifyObserver(o)}>再検証</button>
                <button type="button" className="danger" disabled={obsBusy} onClick={() => deleteObserver(o)}>削除</button>
              </span>
            </div>
          ))}

          <h4>卒業状況{graduation ? "（合格 " + graduation.graduated + " 垢）" : ""}</h4>
          {graduation && graduation.accounts.length === 0 && <p className="muted">まだ判定された垢はありません。</p>}
          {graduation?.accounts.map(a => (
            <div key={a.id} className="x-generator-row-head">
              <span>
                @{a.username} — <strong>{a.passed ? "合格" : "未合格"}</strong>（不合格 {a.attempts} 回）
                {a.report?.checks.map(c => (
                  <span key={c.name} className="muted"> ／ {c.name}: {c.status === "pass" ? "○" : c.status === "fail" ? "×" : "？"} {c.detail}</span>
                ))}
              </span>
            </div>
          ))}
        </section>
      )}
      {activeTab === "proxy" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>プロキシ</h3>
              <p className="muted">
                生成に使う住宅プロキシのセッション状況です。1つのIPに割り当てる垢数の上限に達したセッションは、一定期間クーリングして再利用します。
              </p>
            </div>
            <button type="button" className="secondary" onClick={loadProxy} disabled={proxyLoading}>
              {proxyLoading ? "更新中…" : "更新"}
            </button>
          </div>
          {proxyFeedback && <div className="alert error">{proxyFeedback.message}</div>}
          {proxy && (
            <>
              <div className="metric-grid">
                <article className="metric card"><span>セッション数</span><strong>{proxy.summary.total_sessions}</strong></article>
                <article className="metric card"><span>利用可能</span><strong>{proxy.summary.ready}</strong></article>
                <article className="metric card"><span>クーリング中</span><strong>{proxy.summary.cooling}</strong></article>
                <article className="metric card"><span>遮断中</span><strong>{proxy.summary.circuit_open}</strong></article>
              </div>
              <div className="serverless-note">
                <strong>接続先</strong>
                <span>
                  {proxy.config.provider} — {proxy.config.host}:{proxy.config.port}
                  （{proxy.config.country || "国指定なし"}）・1IPあたり最大 {proxy.config.max_accounts_per_ip} 垢
                </span>
                <span>プロキシ業者や認証情報の変更は、ジェネレーター側の設定ファイルで行います。</span>
              </div>

              <div className="button-row">
                <button
                  type="button"
                  className="primary"
                  onClick={startProxyHealthCheck}
                  disabled={proxyBusy || proxy.health_check.running}
                >
                  {proxy.health_check.running ? "ヘルスチェック実行中…" : "全セッションのヘルスチェック"}
                </button>
              </div>
              {proxy.health_check.result && !proxy.health_check.running && (
                <div className={proxy.health_check.result.error ? "alert error" : "alert success"}>
                  {proxy.health_check.result.error
                    ? "ヘルスチェックに失敗しました: " + proxy.health_check.result.error
                    : "前回のヘルスチェック: " + proxy.health_check.result.healthy + " / " + proxy.health_check.result.checked + " セッションが正常"}
                  {proxy.health_check.finished_at ? "（" + new Date(proxy.health_check.finished_at * 1000).toLocaleString("ja-JP") + "）" : ""}
                </div>
              )}

              <div className="list-stack">
                {proxy.sessions.map(row => (
                  <div className="serverless-note" key={row.session_id}>
                    <div className="x-generator-row-head">
                      <span className={`status-pill ${PROXY_STATE_TONE[row.state]}`}><i />{PROXY_STATE_LABEL[row.state]}</span>
                      <strong>セッション {row.session_id}</strong>
                    </div>
                    <span>
                      割当 {row.account_count}/{row.max_accounts} 垢 ・ 紐付き {row.assigned_accounts} 垢 ・
                      出口IP {row.last_exit_ip ?? "未確認"}
                      {row.last_signup_at ? " ・ 最終使用 " + new Date(row.last_signup_at).toLocaleString("ja-JP") : ""}
                    </span>
                    {row.state === "cooling" && row.cooldown_until && (
                      <span>クーリング解除予定 {new Date(row.cooldown_until).toLocaleString("ja-JP")}</span>
                    )}
                    {row.state === "circuit_open" && row.circuit_open_until && (
                      <span>連続失敗 {row.consecutive_failures} 回 ・ 自動再試行 {new Date(row.circuit_open_until).toLocaleString("ja-JP")}</span>
                    )}
                    <div className="button-row">
                      {(row.state === "circuit_open" || row.consecutive_failures > 0) && (
                        <button type="button" className="secondary" onClick={() => resetProxyCircuit(row)} disabled={proxyBusy}>
                          遮断を解除
                        </button>
                      )}
                      {(row.state === "cooling" || row.state === "full") && (
                        <button type="button" className="danger" onClick={() => resetProxyCooldown(row)} disabled={proxyBusy}>
                          クーリングを解除
                        </button>
                      )}
                      {row.assigned_accounts === 0 && (
                        <button type="button" className="danger" onClick={() => deleteProxySession(row)} disabled={proxyBusy}>
                          削除
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                {proxy.sessions.length === 0 && <p className="muted">まだセッションがありません。垢を生成すると自動で作られます。</p>}
              </div>
            </>
          )}
        </section>
      )}

      {activeTab === "server" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>サーバー</h3>
              <p className="muted">ジェネレーターが動いているサーバー（VPS）の状態です。</p>
            </div>
            <button type="button" className="secondary" onClick={loadServerInfo} disabled={serverLoading}>
              {serverLoading ? "更新中…" : "更新"}
            </button>
          </div>
          {serverFeedback && <div className="alert error">{serverFeedback.message}</div>}
          {serverInfo && (
            <>
              <div className="metric-grid">
                <article className="metric card">
                  <span>メモリ</span>
                  <strong>{serverInfo.memory ? formatPercent(serverInfo.memory.used, serverInfo.memory.total) : "—"}</strong>
                  <small>{serverInfo.memory ? formatBytes(serverInfo.memory.used) + " / " + formatBytes(serverInfo.memory.total) : "取得できません"}</small>
                </article>
                <article className="metric card">
                  <span>ディスク</span>
                  <strong>{serverInfo.disk ? formatPercent(serverInfo.disk.used, serverInfo.disk.total) : "—"}</strong>
                  <small>{serverInfo.disk ? "空き " + formatBytes(serverInfo.disk.free) : "取得できません"}</small>
                </article>
                <article className="metric card">
                  <span>CPU負荷（1分）</span>
                  <strong>{serverInfo.load_average ? serverInfo.load_average[0]!.toFixed(2) : "—"}</strong>
                  <small>{serverInfo.cpu_count ? serverInfo.cpu_count + " コア" : ""}</small>
                </article>
                <article className="metric card">
                  <span>稼働時間</span>
                  <strong>{formatDuration(serverInfo.host_uptime_seconds ?? serverInfo.api_uptime_seconds)}</strong>
                  <small>{serverInfo.host_uptime_seconds !== null ? "サーバー全体" : "APIプロセス"}</small>
                </article>
              </div>
              <div className="list-stack">
                <div className="serverless-note">
                  <strong>サーバー</strong>
                  <span>{serverInfo.hostname} ・ {serverInfo.platform} ・ Python {serverInfo.python}</span>
                </div>
                <div className="serverless-note">
                  <strong>ジェネレーターAPI</strong>
                  <span>
                    起動から {formatDuration(serverInfo.api_uptime_seconds)} ・ 垢生成ジョブ {serverInfo.orchestrator_running ? "実行中" : "停止中"}
                  </span>
                </div>
                <div className="serverless-note">
                  <strong>データ</strong>
                  <span>データベース {formatBytes(serverInfo.db_size_bytes)} ・ ログ {formatBytes(serverInfo.log_size_bytes)}</span>
                </div>
                {serverInfo.load_average && (
                  <div className="serverless-note">
                    <strong>CPU負荷平均</strong>
                    <span>1分 {serverInfo.load_average[0]!.toFixed(2)} ・ 5分 {serverInfo.load_average[1]!.toFixed(2)} ・ 15分 {serverInfo.load_average[2]!.toFixed(2)}</span>
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}

      {activeTab === "server" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>VPS契約</h3>
              <p className="muted">契約しているサーバー（1台）の料金です。月額は日割りにして、垢の単価に自動で含めます。</p>
            </div>
          </div>
          <div className="form-grid two">
            <label className="field">
              <span>名前</span>
              <input value={vpsLabel} onChange={e => setVpsLabel(e.target.value)} placeholder="例: ジェネレーター用VPS" maxLength={100} />
            </label>
            <label className="field">
              <span>契約先</span>
              <input value={vpsProvider} onChange={e => setVpsProvider(e.target.value)} placeholder="例: ConoHa" maxLength={100} />
            </label>
            <label className="field">
              <span>月額（円）</span>
              <input type="number" min={0} value={vpsFee} onChange={e => setVpsFee(e.target.value)} />
            </label>
            <label className="field">
              <span>支払日（毎月）</span>
              <input type="number" min={1} max={31} value={vpsBillingDay} onChange={e => setVpsBillingDay(e.target.value)} placeholder="例: 25" />
              <small>月末より大きい日は、その月の末日として扱います。</small>
            </label>
            <label className="field">
              <span>契約開始日</span>
              <input type="date" value={vpsStartedAt} onChange={e => setVpsStartedAt(e.target.value)} />
              <small>この日より前の分は単価に含めません。</small>
            </label>
            <label className="field">
              <span>メモ</span>
              <input value={vpsNote} onChange={e => setVpsNote(e.target.value)} maxLength={500} />
            </label>
          </div>
          <div className="button-row">
            <button type="button" className="primary" onClick={saveVpsContract} disabled={vpsBusy}>
              {vpsBusy ? "保存中…" : "VPS契約を保存"}
            </button>
          </div>
          {costs?.vps.next_due && (
            <div className="serverless-note">
              <strong>次の支払日</strong>
              <span>{costs.vps.next_due}（月額 {formatYen(costs.vps.monthly_fee_jpy)}）</span>
            </div>
          )}
          {vpsFeedback && <div className={vpsFeedback.kind === "error" ? "alert error" : "alert success"}>{vpsFeedback.message}</div>}
        </section>
      )}

      {activeTab === "server" && (
        <section className="card">
          <div className="section-head">
            <div>
              <h3>ログ</h3>
              <p className="muted">ジェネレーターの最新のログ（最大200行）です。パスワードやトークンは自動で伏せています。</p>
            </div>
            <button type="button" className="secondary" onClick={() => loadLogs(logLevel)} disabled={logLoading}>
              {logLoading ? "更新中…" : "更新"}
            </button>
          </div>
          <div className="form-grid two">
            <label className="field">
              <span>表示するレベル</span>
              <select value={logLevel} onChange={e => { setLogLevel(e.target.value); loadLogs(e.target.value); }}>
                <option value="">すべて</option>
                <option value="ERROR">エラーのみ</option>
                <option value="WARNING">警告のみ</option>
                <option value="INFO">情報のみ</option>
              </select>
            </label>
          </div>
          {logFeedback && <div className="alert error">{logFeedback.message}</div>}
          {!logAvailable && <p className="muted">ログファイルがまだありません。</p>}
          {logAvailable && logLines && (
            <pre className="x-generator-log" aria-label="ジェネレーターのログ">
              {logLines.length ? logLines.join("\n") : "該当するログはありません。"}
            </pre>
          )}
        </section>
      )}
      {activeTab === "perks" && (() => {
        const renderPool = (system: PoolSystem, title: string, description: string, stock: number | null) => {
          const form = poolForms[system];
          const rule = restockRules.find(r => r.targetSystem === system) ?? null;
          return (
            <>
              <div className="metric-grid x-generator-single">
                <article className="metric card">
                  <span>{title}の在庫</span>
                  <strong>{stock ?? "—"}</strong>
                  <small>配れる垢の数</small>
                </article>
              </div>
              <p className="muted">{description}</p>

              <h4>ジェネレーターの垢を割り当てる</h4>
              <div className="form-grid two">
                <label className="field">
                  <span>在庫追加数</span>
                  <input type="number" min={1} max={200} value={form.assignCount} onChange={e => updatePoolForm(system, { assignCount: e.target.value })} />
                </label>
                <label className="field">
                  <span>最低ウォームアップ日数</span>
                  <input type="number" min={0} max={365} value={form.warmupDays} onChange={e => updatePoolForm(system, { warmupDays: e.target.value })} />
                  <small>0なら制限しません。自動補充にも使われます。</small>
                </label>
              </div>
              <div className="button-row">
                <button type="button" className="primary" onClick={() => assignToPool(system)} disabled={perksBusy}>
                  {perksBusy ? "処理中…" : "今すぐ割り当てる"}
                </button>
              </div>

              <h4>自動補充</h4>
              {rule ? (
                <div className="serverless-note">
                  <strong>{rule.enabled ? "有効" : "無効"} ・ 最低 {rule.minStock} / 目標 {rule.targetStock} / 1回最大 {rule.maxBatch}</strong>
                  <span>
                    {rule.lastRunAt ? "最終確認 " + new Date(rule.lastRunAt).toLocaleString("ja-JP") : "未実行"}
                    {rule.lastAdded > 0 ? "（前回 " + rule.lastAdded + " 垢補充）" : ""}
                    {rule.lastError ? " ・ エラー: " + rule.lastError : ""}
                  </span>
                  <div className="button-row">
                    <button type="button" className="secondary" onClick={() => togglePoolRule(rule)} disabled={perksBusy}>
                      {rule.enabled ? "無効にする" : "有効にする"}
                    </button>
                    <button type="button" className="danger" onClick={() => removePoolRule(rule)} disabled={perksBusy}>削除</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="form-grid two">
                    <label className="field">
                      <span>最低在庫数</span>
                      <input type="number" min={0} value={form.minStock} onChange={e => updatePoolForm(system, { minStock: e.target.value })} />
                      <small>在庫がこの数を下回ったら補充します。</small>
                    </label>
                    <label className="field">
                      <span>目標在庫数</span>
                      <input type="number" min={0} value={form.targetStock} onChange={e => updatePoolForm(system, { targetStock: e.target.value })} />
                    </label>
                    <label className="field">
                      <span>1回あたりの補充上限</span>
                      <input type="number" min={1} max={200} value={form.maxBatch} onChange={e => updatePoolForm(system, { maxBatch: e.target.value })} />
                    </label>
                  </div>
                  <div className="button-row">
                    <button type="button" className="secondary" onClick={() => createPoolRule(system)} disabled={perksBusy}>
                      自動補充を設定
                    </button>
                  </div>
                </>
              )}
            </>
          );
        };

        return (
          <>
            {perksFeedback && <div className={perksFeedback.kind === "error" ? "alert error" : "alert success"}>{perksFeedback.message}</div>}

            {pending.length > 0 && (
              <section className="card">
                <div className="alert error">
                  納品待ちの垢が {pending.reduce((sum, p) => sum + p.count, 0)} 件あります。取り出し済みなので消えません。1分ごとに自動で再納品します。
                </div>
                <div className="list-stack">
                  {pending.map(p => (
                    <div className="serverless-note" key={p.id}>
                      <strong>{TARGET_SYSTEM_LABEL[p.targetSystem] ?? p.targetSystem} ・ {p.count} 垢 ・ 試行 {p.attempts} 回</strong>
                      <span>{p.lastError ?? ""}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section className="card">
              <div className="section-head">
                <div>
                  <h3>招待キャンペーン</h3>
                  <p className="muted">「◯人招待で垢プレゼント」の景品の在庫です。有効化・人数条件・パネル設置は「アフィリエイト」タブで設定します。</p>
                </div>
                <button type="button" className="secondary" onClick={loadPerks} disabled={perksLoading}>
                  {perksLoading ? "更新中…" : "更新"}
                </button>
              </div>
              {renderPool(
                "invite", "招待キャンペーン",
                "ここに入れた垢が先に景品として使われます。アフィリエイトタブで販売中の商品と在庫を共有するよう設定した場合は、その商品の在庫として入荷します。",
                inviteStock
              )}
            </section>

            <section className="card">
              <div className="section-head">
                <div>
                  <h3>無料配布（1人1個）</h3>
                  <p className="muted">Discordアカウントごとに1個配る景品の在庫です。有効化・不正受け取り対策・パネル設置は「アフィリエイト」タブで設定します。</p>
                </div>
              </div>
              {renderPool(
                "giveaway", "無料配布",
                "在庫が0になると、ボタンを押した人は「在庫切れ」と表示され、入荷後に同じボタンでもう一度受け取れます。アフィリエイトタブで販売中の商品と在庫を共有するよう設定した場合は、その商品の在庫として入荷します。",
                giveaway?.stockCount ?? null
              )}
            </section>
          </>
        );
      })()}

      {activeTab === "cost" && (
        <>
          <section className="card">
            <div className="section-head">
              <div>
                <h3>垢の単価</h3>
                <p className="muted">
                  支払いの記録とVPS料金（日割り）を、作った垢の数で割って常に計算します。
                  「見込み」はBANされていない垢あたり、「実績」は販売可能になった垢あたりです。
                </p>
              </div>
              <button type="button" className="secondary" onClick={() => { loadCosts(); loadExpenses(); }} disabled={costsLoading}>
                {costsLoading ? "更新中…" : "更新"}
              </button>
            </div>
            {costsFeedback && <div className="alert error">{costsFeedback.message}</div>}
            {costs && (
              <div className="list-stack">
                {costs.windows.map(win => (
                  <div className="serverless-note" key={win.key}>
                    <strong>{win.label}</strong>
                    <div className="x-generator-unit-cost compact">
                      <article className="metric card">
                        <span>見込み単価</span>
                        <strong>{formatYen(win.unit_cost.per_alive)}</strong>
                        <small>生きている垢 {win.accounts.alive} 件</small>
                      </article>
                      <article className="metric card">
                        <span>実績単価</span>
                        <strong>{formatYen(win.unit_cost.per_ready)}</strong>
                        <small>販売可能な垢 {win.accounts.ready} 件</small>
                      </article>
                    </div>
                    <span>
                      総コスト {formatYen(win.costs.total)} ・ 作成 {win.accounts.created} 件 ・ BAN・凍結 {win.accounts.failed} 件
                      {win.yield_rate !== null ? " ・ 生存率 " + Math.round(win.yield_rate * 100) + "%" : ""}
                    </span>
                    <span>
                      {Object.keys(COST_PART_LABEL)
                        .map(key => COST_PART_LABEL[key] + " " + formatYen(win.costs[key as keyof CostWindow["costs"]]))
                        .join(" ・ ")}
                    </span>
                    {win.unit_breakdown && (
                      <span>
                        1垢あたりの内訳:{" "}
                        {Object.keys(COST_PART_LABEL)
                          .filter(key => (win.unit_breakdown?.[key] ?? 0) > 0)
                          .map(key => COST_PART_LABEL[key] + " " + formatYen(win.unit_breakdown?.[key]))
                          .join(" ・ ") || "—"}
                      </span>
                    )}
                  </div>
                ))}
                <p className="muted">
                  プロキシは通信量のチャージ額を、チャージした日に計上します。まとめてチャージした直後は一時的に高く出るので、
                  普段は「累計」と見比べてください。
                </p>
              </div>
            )}
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <h3>支払いを記録</h3>
                <p className="muted">プロキシの通信量チャージ、SMS・Captchaの購入などを記録します。VPSは「サーバー」タブの契約で自動計上されるので、ここには入れないでください。</p>
              </div>
            </div>
            <div className="form-grid two">
              <label className="field">
                <span>種類</span>
                <select value={expenseCategory} onChange={e => setExpenseCategory(e.target.value)}>
                  {Object.keys(EXPENSE_CATEGORY_LABEL).map(key => (
                    <option key={key} value={key}>{EXPENSE_CATEGORY_LABEL[key]}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>内容</span>
                <input value={expenseDescription} onChange={e => setExpenseDescription(e.target.value)} placeholder="例: 10GBチャージ" maxLength={200} />
              </label>
              <label className="field">
                <span>金額</span>
                <input type="number" min={0} step="any" value={expenseAmount} onChange={e => setExpenseAmount(e.target.value)} />
              </label>
              <label className="field">
                <span>通貨</span>
                <select value={expenseCurrency} onChange={e => setExpenseCurrency(e.target.value)}>
                  <option value="JPY">円（JPY）</option>
                  <option value="USD">米ドル（USD）</option>
                  <option value="EUR">ユーロ（EUR）</option>
                </select>
              </label>
              {expenseCurrency !== "JPY" && (
                <label className="field">
                  <span>換算レート（1{expenseCurrency} = 何円）</span>
                  <input type="number" min={0} step="any" value={expenseRate} onChange={e => setExpenseRate(e.target.value)} placeholder="例: 150" />
                  <small>支払い時点のレートを入力してください。</small>
                </label>
              )}
              {expenseCategory === "proxy" && (
                <label className="field">
                  <span>購入した通信量（GB）</span>
                  <input type="number" min={0} step="any" value={expenseQuantity} onChange={e => setExpenseQuantity(e.target.value)} />
                  <small>入力すると平均の円/GBを計算できます。</small>
                </label>
              )}
              <label className="field">
                <span>支払日</span>
                <input type="date" value={expensePaidAt} onChange={e => setExpensePaidAt(e.target.value)} />
              </label>
              <label className="field">
                <span>メモ</span>
                <input value={expenseNote} onChange={e => setExpenseNote(e.target.value)} maxLength={500} />
              </label>
            </div>
            <div className="button-row">
              <button type="button" className="primary" onClick={handleAddExpense} disabled={expenseBusy}>
                {expenseBusy ? "記録中…" : "支払いを記録"}
              </button>
            </div>
            {expenseFeedback && (
              <div className={expenseFeedback.kind === "error" ? "alert error" : "alert success"}>{expenseFeedback.message}</div>
            )}
          </section>

          <section className="card">
            <div className="section-head">
              <div>
                <h3>支払い履歴</h3>
                {costs && costs.proxy.payments > 0 && (
                  <p className="muted">
                    プロキシ: 累計 {formatYen(costs.proxy.total_paid_jpy)}（{costs.proxy.payments}回）
                    {costs.proxy.total_gb > 0 ? " ・ " + costs.proxy.total_gb + "GB ・ 平均 " + formatYen(costs.proxy.avg_jpy_per_gb) + "/GB" : ""}
                    {costs.proxy.last_paid_at ? " ・ 最終 " + costs.proxy.last_paid_at : ""}
                  </p>
                )}
              </div>
            </div>
            <div className="list-stack">
              {expenses.map(row => (
                <div className="serverless-note" key={row.id}>
                  <strong>{row.paid_at} ・ {EXPENSE_CATEGORY_LABEL[row.category] ?? row.category} ・ {formatYen(row.amount_jpy)}</strong>
                  <span>
                    {row.description || "（内容なし）"}
                    {row.currency !== "JPY" ? " ・ " + row.amount_original + " " + row.currency + "（1" + row.currency + "=" + row.rate_to_jpy + "円）" : ""}
                    {row.quantity ? " ・ " + row.quantity + (row.unit ?? "") : ""}
                    {row.note ? " ・ " + row.note : ""}
                  </span>
                  <div className="button-row">
                    <button type="button" className="danger" onClick={() => deleteExpense(row)} disabled={expenseBusy}>削除</button>
                  </div>
                </div>
              ))}
              {expenses.length === 0 && <p className="muted">まだ支払いの記録がありません。</p>}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
