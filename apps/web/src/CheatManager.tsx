import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import "./cheat-manager.css";

type CheatGame = "nyanko" | "tsum" | "puni";
const GAME_ORDER: CheatGame[] = ["nyanko", "tsum", "puni"];

type PanelState = {
  channelId: string | null;
  color: number | null;
  messageId: string | null;
  deployedChannelId: string | null;
  deployedAt: number | null;
};

type GameAchievement = { enabled: boolean; channelId: string | null };

type Achievements = {
  enabled: boolean;
  channelId: string | null;
  color: number;
  showAmount: boolean;
  showUser: boolean;
  games: Record<CheatGame, GameAchievement>;
  counters: Record<CheatGame, number>;
};

type CheatChannel = { id: string; name: string; canPost: boolean };

type CheatConfig = {
  guildId: string;
  guildName: string;
  games: { key: CheatGame; label: string; panelName: string; defaultColor: number }[];
  panels: Record<CheatGame, PanelState>;
  achievements: Achievements;
  channels: CheatChannel[];
};

type Props = {
  guildId: string;
  channels?: { id: string; name: string; type?: string }[];
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
};

type Feedback = { kind: "success" | "error" | "info"; message: string };

type PanelDraft = { channelId: string; color: number };

const hex = (value: number) => "#" + value.toString(16).padStart(6, "0");
const fromHex = (value: string) => Number.parseInt(value.slice(1), 16);
const messageOf = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export default function CheatManager({ guildId, onNotice, onError }: Props) {
  const [config, setConfig] = useState<CheatConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [panelDrafts, setPanelDrafts] = useState<Record<string, PanelDraft>>({});
  const [ach, setAch] = useState<Achievements | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback | undefined>>({});

  const applyConfig = useCallback((next: CheatConfig) => {
    setConfig(next);
    setAch(next.achievements);
    const drafts: Record<string, PanelDraft> = {};
    for (const game of next.games) {
      const saved = next.panels[game.key];
      drafts[game.key] = {
        channelId: saved.channelId ?? "",
        color: saved.color ?? game.defaultColor
      };
    }
    setPanelDrafts(drafts);
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      applyConfig(await api<CheatConfig>("/api/guilds/" + guildId + "/cheat/config"));
    } catch (reason) {
      setConfig(null);
      setLoadError(messageOf(reason));
    }
  }, [guildId, applyConfig]);

  useEffect(() => {
    void load();
  }, [load]);

  const postable = useMemo(
    () => (config?.channels ?? []).filter((channel) => channel.canPost),
    [config]
  );
  const channelName = (id: string | null) =>
    config?.channels.find((channel) => channel.id === id)?.name ?? id ?? "";

  function setNote(key: string, value: Feedback | undefined) {
    setFeedback((current) => ({ ...current, [key]: value }));
  }

  function note(key: string) {
    const value = feedback[key];
    if (!value) return null;
    return (
      <div className={"panel-feedback " + value.kind} role="status" aria-live="polite">
        {value.message}
      </div>
    );
  }

  function channelSelect(
    value: string,
    onChange: (value: string) => void,
    empty: string,
    label: string
  ) {
    const known = postable.some((channel) => channel.id === value);
    return (
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{empty}</option>
        {value && !known && <option value={value}>#{channelName(value)}（投稿権限なし）</option>}
        {postable.map((channel) => (
          <option key={channel.id} value={channel.id}>
            #{channel.name}
          </option>
        ))}
      </select>
    );
  }

  async function savePanel(game: CheatGame) {
    const draft = panelDrafts[game];
    if (!draft) return;
    setBusy("save:" + game);
    setNote(game, { kind: "info", message: "保存中..." });
    try {
      applyConfig(
        await api<CheatConfig>("/api/guilds/" + guildId + "/cheat/config", {
          method: "PUT",
          body: JSON.stringify({
            panels: { [game]: { channelId: draft.channelId || null, color: draft.color } }
          })
        })
      );
      setNote(game, { kind: "success", message: "設定を保存しました（設置済みパネルへは「設置・更新」で反映）" });
      onNotice("パネル設定を保存しました");
    } catch (reason) {
      setNote(game, { kind: "error", message: "保存に失敗しました: " + messageOf(reason) });
      onError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function deployPanel(game: CheatGame) {
    const draft = panelDrafts[game];
    if (!draft?.channelId) {
      setNote(game, { kind: "error", message: "設置先チャンネルを選択してください" });
      return;
    }
    setBusy("deploy:" + game);
    setNote(game, { kind: "info", message: "パネルを設置中..." });
    try {
      const result = await api<{ channelId: string; updated: boolean }>(
        "/api/guilds/" + guildId + "/cheat/panels/" + game,
        { method: "POST", body: JSON.stringify({ channelId: draft.channelId, color: draft.color }) }
      );
      await load();
      setNote(game, {
        kind: "success",
        message:
          (result.updated ? "既存のパネルを更新しました: #" : "パネルを設置しました: #") +
          channelName(result.channelId)
      });
      onNotice("パネルを設置しました");
    } catch (reason) {
      setNote(game, { kind: "error", message: "設置に失敗しました: " + messageOf(reason) });
      onError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function saveAchievements() {
    if (!ach) return;
    setBusy("save:ach");
    setNote("ach", { kind: "info", message: "保存中..." });
    try {
      const { counters: _counters, ...editable } = ach;
      applyConfig(
        await api<CheatConfig>("/api/guilds/" + guildId + "/cheat/config", {
          method: "PUT",
          body: JSON.stringify({ achievements: editable })
        })
      );
      setNote("ach", { kind: "success", message: "実績設定を保存しました" });
      onNotice("実績設定を保存しました");
    } catch (reason) {
      setNote("ach", { kind: "error", message: "保存に失敗しました: " + messageOf(reason) });
      onError(reason);
    } finally {
      setBusy(null);
    }
  }

  async function testAchievement(game: CheatGame) {
    setBusy("test:" + game);
    setNote("ach", { kind: "info", message: "テスト送信中（保存済みの設定で送ります）..." });
    try {
      const result = await api<{ channelId: string }>(
        "/api/guilds/" + guildId + "/cheat/achievements/test",
        { method: "POST", body: JSON.stringify({ game }) }
      );
      setNote("ach", { kind: "success", message: "#" + channelName(result.channelId) + " にテストを送信しました" });
    } catch (reason) {
      setNote("ach", { kind: "error", message: "テスト送信に失敗しました: " + messageOf(reason) });
      onError(reason);
    } finally {
      setBusy(null);
    }
  }

  function patchAch(patch: Partial<Achievements>) {
    setAch((current) => (current ? { ...current, ...patch } : current));
  }

  function patchGameAch(game: CheatGame, patch: Partial<GameAchievement>) {
    setAch((current) =>
      current
        ? { ...current, games: { ...current.games, [game]: { ...current.games[game], ...patch } } }
        : current
    );
  }

  function preview(color: number, title: string, body: string) {
    return (
      <div className="cheat-embed-preview" aria-hidden="true" style={{ borderLeftColor: hex(color) }}>
        <strong>{title}</strong>
        <span>{body}</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <section className="stack">
        <article className="card">
          <div className="section-head">
            <div>
              <span className="eyebrow">代行管理</span>
              <h2>Discord-Cheatに接続できません</h2>
            </div>
          </div>
          <div className="panel-feedback error" role="alert">{loadError}</div>
          <div className="button-row">
            <button type="button" className="primary" onClick={() => void load()}>
              再読み込み
            </button>
          </div>
          <p className="muted">
            Xaccount-Botに CHEAT_API_BASE_URL / CHEAT_BRIDGE_SECRET を設定し、Discord-Cheat BOTを
            このサーバーへ招待・起動してください。
          </p>
        </article>
      </section>
    );
  }

  if (!config || !ach) {
    return (
      <section className="stack">
        <article className="card"><p className="muted">読み込み中...</p></article>
      </section>
    );
  }

  return (
    <section className="stack">
      {config.games.map((game) => {
        const draft = panelDrafts[game.key] ?? { channelId: "", color: game.defaultColor };
        const saved = config.panels[game.key];
        const deployed = saved.messageId && saved.deployedChannelId;
        return (
          <article className="card cheat-card" key={game.key}>
            <div className="section-head">
              <div>
                <span className="eyebrow">代行管理</span>
                <h2>{game.panelName}</h2>
                <p className="muted">
                  {game.label}の代行パネルを選んだチャンネルへ設置します。同じチャンネルなら既存パネルを更新します。
                </p>
              </div>
              <strong>{deployed ? "設置済み" : "未設置"}</strong>
            </div>

            <label className="field">
              <span>設置先チャンネル</span>
              {channelSelect(
                draft.channelId,
                (value) =>
                  setPanelDrafts((current) => ({ ...current, [game.key]: { ...draft, channelId: value } })),
                "チャンネルを選択",
                game.panelName + "の設置先チャンネル"
              )}
            </label>

            <div className="cheat-color-row">
              <label className="field cheat-color">
                <span>パネルの色</span>
                <input
                  type="color"
                  aria-label={game.panelName + "の色"}
                  value={hex(draft.color)}
                  onChange={(event) =>
                    setPanelDrafts((current) => ({
                      ...current,
                      [game.key]: { ...draft, color: fromHex(event.target.value) }
                    }))
                  }
                />
              </label>
              <code>{hex(draft.color).toUpperCase()}</code>
              <button
                type="button"
                disabled={draft.color === game.defaultColor}
                onClick={() =>
                  setPanelDrafts((current) => ({
                    ...current,
                    [game.key]: { ...draft, color: game.defaultColor }
                  }))
                }
              >
                既定色に戻す
              </button>
            </div>
            {preview(draft.color, game.label + "代行", "パネルの色はこの帯の色になります")}

            <div className="button-row">
              <button type="button" disabled={busy !== null} onClick={() => void savePanel(game.key)}>
                {busy === "save:" + game.key ? "保存中..." : "設定を保存"}
              </button>
              <button
                type="button"
                className="primary"
                disabled={busy !== null || !draft.channelId}
                onClick={() => void deployPanel(game.key)}
              >
                {busy === "deploy:" + game.key ? "設置中..." : deployed ? "パネルを更新" : "パネルを設置"}
              </button>
            </div>
            {deployed && (
              <p className="muted">
                設置先: #{channelName(saved.deployedChannelId)}
                {saved.deployedAt ? "（" + new Date(saved.deployedAt).toLocaleString("ja-JP") + "）" : ""}
              </p>
            )}
            {note(game.key)}
          </article>
        );
      })}

      <article className="card cheat-card">
        <div className="section-head">
          <div>
            <span className="eyebrow">代行管理</span>
            <h2>実績</h2>
            <p className="muted">
              3つのパネルで代行が完了するたびに、完了実績を指定チャンネルへ投稿します（Discord-Shiireの購入完了ログと同じ形式・メンションなし）。
            </p>
          </div>
          <strong>{ach.enabled ? "ON" : "OFF"}</strong>
        </div>

        <label className="cheat-check">
          <input
            type="checkbox"
            checked={ach.enabled}
            onChange={(event) => patchAch({ enabled: event.target.checked })}
          />
          <span>実績を投稿する</span>
        </label>

        <label className="field">
          <span>実績の投稿先チャンネル（共通）</span>
          {channelSelect(
            ach.channelId ?? "",
            (value) => patchAch({ channelId: value || null }),
            "投稿しない",
            "実績の投稿先チャンネル"
          )}
        </label>

        <div className="cheat-color-row">
          <label className="field cheat-color">
            <span>実績の色</span>
            <input
              type="color"
              aria-label="実績の色"
              value={hex(ach.color)}
              onChange={(event) => patchAch({ color: fromHex(event.target.value) })}
            />
          </label>
          <code>{hex(ach.color).toUpperCase()}</code>
        </div>
        {preview(ach.color, "✅ 完了実績", "お客様のご依頼を完了しました。")}

        <div className="cheat-checks">
          <label className="cheat-check">
            <input
              type="checkbox"
              checked={ach.showAmount}
              onChange={(event) => patchAch({ showAmount: event.target.checked })}
            />
            <span>金額を表示する</span>
          </label>
          <label className="cheat-check">
            <input
              type="checkbox"
              checked={ach.showUser}
              onChange={(event) => patchAch({ showUser: event.target.checked })}
            />
            <span>ご依頼者を表示する（メンションなし）</span>
          </label>
        </div>

        <div className="cheat-game-rows">
          {config.games.map((game) => {
            const row = ach.games[game.key];
            return (
              <div className="cheat-game-row" key={game.key}>
                <label className="cheat-check">
                  <input
                    type="checkbox"
                    checked={row.enabled}
                    onChange={(event) => patchGameAch(game.key, { enabled: event.target.checked })}
                  />
                  <span>{game.label}</span>
                </label>
                {channelSelect(
                  row.channelId ?? "",
                  (value) => patchGameAch(game.key, { channelId: value || null }),
                  "共通チャンネルを使う",
                  game.label + "の投稿先"
                )}
                <small>{ach.counters[game.key] ?? 0}件</small>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void testAchievement(game.key)}
                >
                  {busy === "test:" + game.key ? "送信中..." : game.label + "でテスト送信"}
                </button>
              </div>
            );
          })}
        </div>

        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={busy !== null}
            onClick={() => void saveAchievements()}
          >
            {busy === "save:ach" ? "保存中..." : "実績設定を保存"}
          </button>
        </div>
        {note("ach")}
        <p className="muted">テスト送信は保存済みの設定で行います。先に「実績設定を保存」を押してください。</p>
      </article>
    </section>
  );
}
