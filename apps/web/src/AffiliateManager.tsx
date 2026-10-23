import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

type Props = {
  guildId: string;
  channels: Array<{ id: string; name: string; type?: string; botCanPost?: boolean }>;
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
};

type Feedback = { kind: "success" | "error"; message: string };

type RewardSource = {
  mode: "dedicated" | "product";
  productId: string | null;
  productName: string | null;
  machineName: string | null;
  unavailable: boolean;
  stockCount: number;
};

type InviteDashboard = {
  settings: { enabled: boolean; guild_id: string; invites_per_reward: number; target_stock: number };
  source: RewardSource;
  stock: { available: number; target: number; deficit: number };
  runtime: { gateway_ready_at: number | null; last_event_at: number | null; last_error: string | null };
  unresolvedRewards: number;
  progress: Array<{ inviter_user_id: string; valid_invites: number; excluded_invites: number; rewards_earned: number }>;
  rewards: Array<{ id: string; inviter_user_id: string; ordinal: number; status: string; error: string | null }>;
  currentGuildSelected: boolean;
};

type GiveawayDashboard = {
  enabled: boolean;
  burstLimit: number;
  burstWindowMinutes: number;
  blocked: Array<{ user_id: string; reason: string | null; created_at: number }>;
  source: RewardSource;
  stockCount: number;
  reservedCount: number;
  claims: Record<string, number>;
  recent: Array<{ user_id: string; status: string; error: string | null; attempts: number; updated_at: number; delivered_at: number | null }>;
};

type CandidateProduct = {
  id: string;
  name: string;
  machineId: string;
  machineName: string;
  procurementClass: string | null;
  stockCount: number;
};

type AffiliateData = {
  invite: InviteDashboard;
  giveaway: GiveawayDashboard;
  products: CandidateProduct[];
};

const CLAIM_STATUS_LABEL: Record<string, string> = {
  DELIVERED: "配布済み",
  WAITING_STOCK: "在庫待ち",
  DM_FAILED: "DM失敗",
  DELIVERY_UNCERTAIN: "要確認",
  CLAIMING: "処理中",
  SENDING: "送信中",
  ERROR: "エラー"
};

function when(value: number | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("ja-JP");
}

export default function AffiliateManager({ guildId, channels, onNotice, onError }: Props) {
  const base = "/api/guilds/" + guildId + "/shiire";
  const [data, setData] = useState<AffiliateData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [panelChannelId, setPanelChannelId] = useState("");
  const [burstInput, setBurstInput] = useState("");
  const [blockUserId, setBlockUserId] = useState("");
  const [blockReason, setBlockReason] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    api<AffiliateData>(base + "/affiliate")
      .then(next => {
        setData(next);
        setBurstInput(String(next.giveaway.burstLimit));
        setFeedback(null);
      })
      .catch(err => setFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }))
      .finally(() => setLoading(false));
  }, [base]);

  useEffect(() => {
    setData(null);
    load();
  }, [load]);

  const run = (request: Promise<unknown>, successMessage: string) => {
    setBusy(true);
    setFeedback(null);
    request
      .then(() => { onNotice(successMessage); load(); })
      .catch(err => { setFeedback({ kind: "error", message: err instanceof Error ? err.message : String(err) }); onError(err); })
      .finally(() => setBusy(false));
  };

  const setProduct = (kind: "invite" | "giveaway", productId: string) => {
    run(
      api(base + "/affiliate/" + kind + "/product", {
        method: "POST",
        body: JSON.stringify({ productId: productId || null }),
        headers: { "Content-Type": "application/json" }
      }),
      productId ? "共有する商品を設定しました" : "専用在庫に戻しました"
    );
  };

  const saveInviteSettings = (patch: Partial<InviteDashboard["settings"]>) => {
    if (!data) return;
    const next = { ...data.invite.settings, ...patch };
    if (
      !data.invite.currentGuildSelected &&
      next.guild_id &&
      !confirm("招待キャンペーンの対象を現在選択中のサーバーへ切り替えますか？")
    ) return;
    run(
      api(base + "/invite-campaign/settings", {
        method: "POST",
        body: JSON.stringify({
          enabled: next.enabled,
          invitesPerReward: Number(next.invites_per_reward),
          targetStock: Number(next.target_stock)
        }),
        headers: { "Content-Type": "application/json" }
      }),
      "招待キャンペーン設定を保存しました"
    );
  };

  const seedInvite = () => run(api(base + "/invite-campaign/seed", { method: "POST", body: "{}" }), "Discord招待状態を再同期しました");

  const retryReward = (id: string) =>
    run(api(base + "/invite-campaign/rewards/" + encodeURIComponent(id) + "/retry", { method: "POST", body: "{}" }), "招待報酬の配布を再試行しました");

  const setGiveawayEnabled = (enabled: boolean) => {
    if (enabled && !confirm("無料配布を開始します。パネルのボタンを押した人に、1人1個ずつ在庫のXアカウントが送られます。よろしいですか？")) return;
    run(
      api(base + "/free-giveaway/settings", {
        method: "POST",
        body: JSON.stringify({ enabled }),
        headers: { "Content-Type": "application/json" }
      }),
      enabled ? "無料配布を開始しました" : "無料配布を停止しました"
    );
  };

  const saveBurstLimit = () => {
    const limit = Number(burstInput);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) {
      setFeedback({ kind: "error", message: "配布上限は0〜1000の整数で入力してください（0で無効）" });
      return;
    }
    run(
      api(base + "/free-giveaway/settings", {
        method: "POST",
        body: JSON.stringify({ burstLimit: limit }),
        headers: { "Content-Type": "application/json" }
      }),
      "配布上限を保存しました"
    );
  };

  const blockUser = () => {
    const userId = blockUserId.trim();
    if (!/^\d{15,25}$/.test(userId)) {
      setFeedback({ kind: "error", message: "DiscordのユーザーID（数字17〜20桁ほど）を入力してください" });
      return;
    }
    run(
      api(base + "/free-giveaway/blocklist", {
        method: "POST",
        body: JSON.stringify({ userId, reason: blockReason }),
        headers: { "Content-Type": "application/json" }
      }),
      "受け取り禁止に追加しました"
    );
    setBlockUserId("");
    setBlockReason("");
  };

  const unblockUser = (userId: string) => {
    if (!confirm("ユーザーID " + userId + " の受け取り禁止を解除しますか？")) return;
    run(api(base + "/free-giveaway/blocklist/" + encodeURIComponent(userId), { method: "DELETE" }), "受け取り禁止を解除しました");
  };

  const postPanel = () => {
    if (!panelChannelId) {
      setFeedback({ kind: "error", message: "パネルを設置するチャンネルを選んでください" });
      return;
    }
    run(
      api(base + "/free-giveaway/panel", {
        method: "POST",
        body: JSON.stringify({ channelId: panelChannelId }),
        headers: { "Content-Type": "application/json" }
      }),
      "無料配布のパネルを設置しました"
    );
  };

  const productPicker = (kind: "invite" | "giveaway", source: RewardSource) => (
    <label className="field">
      <span>景品の在庫</span>
      <select value={source.mode === "product" ? source.productId ?? "" : ""} onChange={e => setProduct(kind, e.target.value)} disabled={busy}>
        <option value="">専用在庫（生成アカウントのみ・他の商品とは別）</option>
        {(data?.products ?? []).map(p => (
          <option key={p.id} value={p.id}>{p.machineName} / {p.name}（在庫 {p.stockCount}）</option>
        ))}
      </select>
      <small>
        既存の自販機の商品を選ぶと、その商品の在庫をそのまま景品として共有します（補充も販売在庫も1本化されます）。
        {source.mode === "product" && source.unavailable && " 選択中の商品が見つかりません。在庫が0のままなら商品を選び直してください。"}
      </small>
    </label>
  );

  if (!data) {
    return (
      <>
        {loading && <div className="progress"><span /></div>}
        {feedback && <div className="alert error">{feedback.message}</div>}
      </>
    );
  }

  const { invite, giveaway } = data;

  return (
    <>
      {feedback && <div className={feedback.kind === "error" ? "alert error" : "alert success"}>{feedback.message}</div>}

      <section className="card">
        <div className="section-head">
          <div>
            <h3>招待キャンペーン（◯人招待で垢プレゼント）</h3>
            <p className="muted">Discord標準の招待URLで、設定人数ごとに1垢をDM配布します。</p>
          </div>
          <button type="button" className="secondary" onClick={load} disabled={loading}>{loading ? "更新中…" : "更新"}</button>
        </div>

        {!invite.currentGuildSelected && invite.settings.guild_id && (
          <div className="alert error">現在の招待キャンペーンは別サーバーに設定されています。保存すると、現在選択中のサーバーに切り替わります。</div>
        )}

        <div className="metric-grid">
          <article className="metric card">
            <span>在庫</span>
            <strong>{invite.stock.available} / {invite.stock.target}</strong>
            <small>不足 {invite.stock.deficit}個</small>
          </article>
          <article className="metric card">
            <span>未解決報酬</span>
            <strong>{invite.unresolvedRewards}</strong>
            <small>待機・再試行対象を含む</small>
          </article>
          <article className="metric card">
            <span>Gateway</span>
            <strong>{invite.runtime.gateway_ready_at ? "接続済み" : "未接続"}</strong>
            <small>{when(invite.runtime.gateway_ready_at)}</small>
          </article>
        </div>

        <label className="toggle-row">
          <span className="toggle-copy">
            <strong>招待キャンペーンを有効にする</strong>
            <small>現在選択中のDiscordサーバーを対象にします。</small>
          </span>
          <span className={`switch ${invite.settings.enabled ? "on" : ""}`}>
            <input type="checkbox" checked={invite.settings.enabled} disabled={busy} onChange={e => saveInviteSettings({ enabled: e.target.checked })} />
            <span />
          </span>
        </label>

        {productPicker("invite", invite.source)}

        <div className="form-grid two">
          <label className="field">
            <span>何人招待ごとに1垢</span>
            <input
              type="number" min={1} step={1}
              defaultValue={invite.settings.invites_per_reward}
              onBlur={e => saveInviteSettings({ invites_per_reward: Number(e.target.value) })}
            />
          </label>
          <label className="field">
            <span>専用在庫の恒常目標（専用在庫の時のみ使用）</span>
            <input
              type="number" min={1} step={1}
              defaultValue={invite.settings.target_stock}
              onBlur={e => saveInviteSettings({ target_stock: Number(e.target.value) })}
            />
          </label>
        </div>
        <div className="button-row">
          <button type="button" className="secondary" onClick={seedInvite} disabled={busy}>招待状態を再同期</button>
        </div>

        <div className="two-col">
          <article className="card">
            <h4>招待実績</h4>
            {invite.progress.length === 0
              ? <div className="muted">まだ招待実績はありません。</div>
              : invite.progress.slice(0, 40).map(row => (
                <div className="serverless-note" key={row.inviter_user_id}>
                  <strong>{row.inviter_user_id}</strong>
                  <span>有効 {row.valid_invites}人 / 対象外 {row.excluded_invites}人 / 報酬 {row.rewards_earned}</span>
                </div>
              ))}
          </article>
          <article className="card">
            <h4>報酬履歴</h4>
            {invite.rewards.length === 0
              ? <div className="muted">まだ報酬履歴はありません。</div>
              : invite.rewards.slice(0, 40).map(row => {
                const retryable = ["WAITING_STOCK", "DM_FAILED", "ERROR"].includes(row.status);
                return (
                  <div className="serverless-note" key={row.id}>
                    <strong>{row.inviter_user_id} / #{row.ordinal}</strong>
                    <span>{row.status}{row.error ? " / " + row.error : ""}</span>
                    {retryable && <button type="button" className="secondary" onClick={() => retryReward(row.id)} disabled={busy}>配布を再試行</button>}
                  </div>
                );
              })}
          </article>
        </div>
      </section>

      <section className="card">
        <div className="section-head">
          <div>
            <h3>無料配布（Discordアカウントにつき1個）</h3>
            <p className="muted">パネルのボタンを押した人にDMで無料のXアカウントを送ります。</p>
          </div>
        </div>

        <label className="toggle-row">
          <span className="toggle-copy">
            <strong>無料配布を行う</strong>
            <small>{giveaway.enabled ? "ON: ボタンを押した人に配布しています" : "OFF: ボタンを押しても配布されません"}</small>
          </span>
          <span className={`switch ${giveaway.enabled ? "on" : ""}`}>
            <input type="checkbox" checked={giveaway.enabled} disabled={busy} onChange={e => setGiveawayEnabled(e.target.checked)} />
            <span />
          </span>
        </label>

        {productPicker("giveaway", giveaway.source)}

        <div className="metric-grid">
          <article className="metric card">
            <span>在庫</span>
            <strong>{giveaway.stockCount}</strong>
            <small>確保中 {giveaway.reservedCount}</small>
          </article>
        </div>

        <div className="serverless-note">
          <strong>受け取り状況</strong>
          <span>
            {Object.keys(CLAIM_STATUS_LABEL)
              .filter(key => (giveaway.claims[key] ?? 0) > 0)
              .map(key => CLAIM_STATUS_LABEL[key] + " " + giveaway.claims[key])
              .join(" ・ ") || "まだ誰も受け取っていません"}
          </span>
          {(giveaway.claims.DELIVERY_UNCERTAIN ?? 0) > 0 && (
            <span>「要確認」は送信結果が分からなかった人です。2個目は渡されません。本人に届いたか確認してください。</span>
          )}
        </div>

        <h4>不正受け取り対策</h4>
        <div className="serverless-note">
          <strong>自動で行っていること</strong>
          <span>
            Discordアカウント（ユーザーID）ごとに1個まで。サーバーを抜けて入り直しても増えません。
            メンバー認証（ルール同意）が済んでいない人、タイムアウト中の人、受け取り禁止の人には渡しません。
            連打しても確保されるのは1個だけで、すべての押下を記録しています。
          </span>
        </div>
        <div className="form-grid two">
          <label className="field">
            <span>{giveaway.burstWindowMinutes}分あたりの配布上限（0で無効）</span>
            <input type="number" min={0} max={1000} value={burstInput} onChange={e => setBurstInput(e.target.value)} />
            <small>この数を超えたら、しばらく待ってもらいます。サブ垢を大量に使った一斉受け取りを遅らせます。</small>
          </label>
        </div>
        <div className="button-row">
          <button type="button" className="secondary" onClick={saveBurstLimit} disabled={busy}>配布上限を保存</button>
        </div>

        <div className="form-grid two">
          <label className="field">
            <span>受け取り禁止にするユーザーID</span>
            <input value={blockUserId} onChange={e => setBlockUserId(e.target.value)} placeholder="例: 123456789012345678" />
          </label>
          <label className="field">
            <span>理由（メモ）</span>
            <input value={blockReason} onChange={e => setBlockReason(e.target.value)} maxLength={200} />
          </label>
        </div>
        <div className="button-row">
          <button type="button" className="danger" onClick={blockUser} disabled={busy}>受け取り禁止に追加</button>
        </div>
        {giveaway.blocked.length > 0 && (
          <div className="list-stack">
            {giveaway.blocked.map(b => (
              <div className="serverless-note" key={b.user_id}>
                <strong>ユーザーID {b.user_id}</strong>
                <span>{b.reason ?? "（理由なし）"} ・ {new Date(b.created_at).toLocaleString("ja-JP")}</span>
                <div className="button-row">
                  <button type="button" className="secondary" onClick={() => unblockUser(b.user_id)} disabled={busy}>解除</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <h4>パネルを設置</h4>
        <div className="form-grid two">
          <label className="field">
            <span>設置するチャンネル</span>
            <select value={panelChannelId} onChange={e => setPanelChannelId(e.target.value)}>
              <option value="">選択してください</option>
              {channels
                .filter(c => (c.type === undefined || c.type === "text" || c.type === "announcement") && c.botCanPost !== false)
                .map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
          </label>
        </div>
        <div className="button-row">
          <button type="button" className="secondary" onClick={postPanel} disabled={busy}>パネルを設置</button>
        </div>

        {giveaway.recent.length > 0 && (
          <>
            <h4>最近の受け取り</h4>
            <div className="list-stack">
              {giveaway.recent.map(r => (
                <div className="serverless-note" key={r.user_id}>
                  <strong>{CLAIM_STATUS_LABEL[r.status] ?? r.status} ・ ユーザーID {r.user_id}</strong>
                  <span>
                    {new Date(r.updated_at).toLocaleString("ja-JP")} ・ 押した回数 {r.attempts}{r.attempts >= 5 ? "（多い）" : ""}
                    {r.error ? " ・ " + r.error : ""}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </>
  );
}
