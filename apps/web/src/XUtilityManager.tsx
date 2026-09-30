import { useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Channel = {
  id: string;
  name: string;
  type?: "text" | "voice" | "announcement" | "stage" | "forum" | "media";
  botCanPost?: boolean;
};

type Props = {
  guildId: string;
  channels: Channel[];
  onNotice: (message: string) => void;
  onError: (reason: unknown) => void;
};

type Feedback = {
  kind: "success" | "error" | "info";
  message: string;
};

export default function XUtilityManager({
  guildId,
  channels,
  onNotice,
  onError
}: Props) {
  const messageChannels = useMemo(
    () =>
      channels.filter(
        (channel) =>
          (channel.type === "text" || channel.type === "announcement") &&
          channel.botCanPost !== false
      ),
    [channels]
  );

  const [shadowbanChannelId, setShadowbanChannelId] = useState("");
  const [totpChannelId, setTotpChannelId] = useState("");
  const [busy, setBusy] = useState<"shadowban" | "2fa" | null>(null);
  const [shadowbanFeedback, setShadowbanFeedback] = useState<Feedback | null>(
    null
  );
  const [totpFeedback, setTotpFeedback] = useState<Feedback | null>(null);

  useEffect(() => {
    const first = messageChannels[0]?.id ?? "";
    setShadowbanChannelId((current) =>
      messageChannels.some((channel) => channel.id === current)
        ? current
        : first
    );
    setTotpChannelId((current) =>
      messageChannels.some((channel) => channel.id === current)
        ? current
        : first
    );
  }, [guildId, messageChannels]);

  async function deploy(kind: "shadowban" | "2fa") {
    const isShadowban = kind === "shadowban";
    const channelId = isShadowban ? shadowbanChannelId : totpChannelId;
    const label = isShadowban ? "X 垢状態チェックパネル" : "2FAパネル";
    const setFeedback = isShadowban
      ? setShadowbanFeedback
      : setTotpFeedback;

    if (!channelId) {
      setFeedback({
        kind: "error",
        message: "設置できるテキストチャンネルがありません"
      });
      return;
    }

    setBusy(kind);
    setFeedback({ kind: "info", message: label + "を設置中..." });
    try {
      await api(
        "/api/guilds/" + guildId + "/xutility/" + kind + "/panel",
        {
          method: "POST",
          body: JSON.stringify({ channelId })
        }
      );
      const channelName =
        channels.find((channel) => channel.id === channelId)?.name ?? channelId;
      setFeedback({
        kind: "success",
        message: label + "を #" + channelName + " に設置しました"
      });
      onNotice(label + "を設置しました");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setFeedback({
        kind: "error",
        message: label + "の設置に失敗しました: " + message
      });
      onError(reason);
    } finally {
      setBusy(null);
    }
  }

  function channelSelect(
    value: string,
    onChange: (value: string) => void
  ) {
    return (
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {messageChannels.length === 0 && (
          <option value="">設置可能なチャンネルがありません</option>
        )}
        {messageChannels.map((channel) => (
          <option key={channel.id} value={channel.id}>
            #{channel.name}
          </option>
        ))}
      </select>
    );
  }

  function feedback(value: Feedback | null) {
    if (!value) return null;
    return (
      <div
        className={
          value.kind === "success"
            ? "panel-feedback success"
            : value.kind === "error"
              ? "panel-feedback error"
              : "panel-feedback info"
        }
        role="status"
        aria-live="polite"
      >
        {value.message}
      </div>
    );
  }

  return (
    <section className="stack">
      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">X UTILITY</span>
            <h2>X 垢状態チェック</h2>
            <p className="muted">
              シャドウバン・凍結を確認するX-Utilityパネルを設置します。
            </p>
          </div>
        </div>

        <label className="field">
          <span>パネル設置チャンネル</span>
          {channelSelect(shadowbanChannelId, setShadowbanChannelId)}
        </label>

        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={busy !== null || !shadowbanChannelId}
            onClick={() => void deploy("shadowban")}
          >
            {busy === "shadowban"
              ? "設置中..."
              : "X 垢状態チェックパネルを設置"}
          </button>
        </div>
        {feedback(shadowbanFeedback)}

        <div className="panel-feedback info" role="note">
          管理者向け: Search Ban / Search Suggestion Ban が「現在確認できません」になる場合は、
          X-Utility側のX検索用ログイン情報が無効・期限切れになっていないか確認してください。
          利用者側には内部エラーやログイン情報の更新案内は表示されません。
        </div>
      </article>

      <article className="card">
        <div className="section-head">
          <div>
            <span className="eyebrow">X UTILITY</span>
            <h2>2FAコード生成</h2>
            <p className="muted">
              Base32シークレットから6桁TOTPを生成するX-Utilityパネルを設置します。
            </p>
          </div>
        </div>

        <label className="field">
          <span>パネル設置チャンネル</span>
          {channelSelect(totpChannelId, setTotpChannelId)}
        </label>

        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={busy !== null || !totpChannelId}
            onClick={() => void deploy("2fa")}
          >
            {busy === "2fa" ? "設置中..." : "2FAパネルを設置"}
          </button>
        </div>
        {feedback(totpFeedback)}
      </article>
    </section>
  );
}
