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
  const [formatChannelId, setFormatChannelId] = useState("");
  const [formatFeedback, setFormatFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState<"shadowban" | "2fa" | "account-format" | null>(null);
  const [shadowbanFeedback, setShadowbanFeedback] = useState<Feedback | null>(
    null
  );
  const [totpFeedback, setTotpFeedback] = useState<Feedback | null>(null);
  const [authToken, setAuthToken] = useState("");
  const [ct0, setCt0] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [credentialStatus, setCredentialStatus] = useState<{
    configured: boolean;
    updatedAt: number | null;
  }>({ configured: false, updatedAt: null });
  const [credentialFeedback, setCredentialFeedback] =
    useState<Feedback | null>(null);

  useEffect(() => {
    const first = messageChannels[0]?.id ?? "";
    setShadowbanChannelId((current) =>
      messageChannels.some((channel) => channel.id === current)
        ? current
        : first
    );
    setFormatChannelId((current) => messageChannels.some((channel) => channel.id === current) ? current : first);
    setTotpChannelId((current) =>
      messageChannels.some((channel) => channel.id === current)
        ? current
        : first
    );
  }, [guildId, messageChannels]);

  useEffect(() => {
    let cancelled = false;
    setCredentialFeedback(null);
    void api<{
      configured: boolean;
      updatedAt: number | null;
    }>("/api/guilds/" + guildId + "/xutility/search-credential")
      .then((status) => {
        if (!cancelled) setCredentialStatus(status);
      })
      .catch((reason) => {
        if (cancelled) return;
        setCredentialFeedback({
          kind: "error",
          message:
            "X検索用ログイン情報の状態を取得できません: " +
            (reason instanceof Error ? reason.message : String(reason))
        });
      });
    return () => {
      cancelled = true;
    };
  }, [guildId]);

  async function saveCredential() {
    if (!authToken.trim() || !ct0.trim()) {
      setCredentialFeedback({
        kind: "error",
        message: "auth_token と ct0 を両方入力してください"
      });
      return;
    }

    setCredentialBusy(true);
    setCredentialFeedback({
      kind: "info",
      message: "X検索用ログイン情報を保存中..."
    });
    try {
      const status = await api<{
        configured: boolean;
        updatedAt: number | null;
      }>("/api/guilds/" + guildId + "/xutility/search-credential", {
        method: "PUT",
        body: JSON.stringify({
          session: authToken.trim(),
          csrf: ct0.trim()
        })
      });
      setCredentialStatus(status);
      setAuthToken("");
      setCt0("");
      setCredentialFeedback({
        kind: "success",
        message: "X検索用ログイン情報を保存しました"
      });
      onNotice("X検索用ログイン情報を保存しました");
    } catch (reason) {
      setCredentialFeedback({
        kind: "error",
        message:
          "保存に失敗しました: " +
          (reason instanceof Error ? reason.message : String(reason))
      });
      onError(reason);
    } finally {
      setCredentialBusy(false);
    }
  }

  async function clearCredential() {
    setCredentialBusy(true);
    setCredentialFeedback({
      kind: "info",
      message: "X検索用ログイン情報を削除中..."
    });
    try {
      const status = await api<{
        configured: boolean;
        updatedAt: number | null;
      }>("/api/guilds/" + guildId + "/xutility/search-credential", {
        method: "DELETE"
      });
      setCredentialStatus(status);
      setAuthToken("");
      setCt0("");
      setCredentialFeedback({
        kind: "success",
        message: "X検索用ログイン情報を削除しました"
      });
      onNotice("X検索用ログイン情報を削除しました");
    } catch (reason) {
      setCredentialFeedback({
        kind: "error",
        message:
          "削除に失敗しました: " +
          (reason instanceof Error ? reason.message : String(reason))
      });
      onError(reason);
    } finally {
      setCredentialBusy(false);
    }
  }

  async function deploy(kind: "shadowban" | "2fa" | "account-format") {
    const isShadowban = kind === "shadowban";
    const channelId = isShadowban ? shadowbanChannelId : kind === "2fa" ? totpChannelId : formatChannelId;
    const label = isShadowban ? "X 垢状態チェックパネル" : kind === "2fa" ? "2FAパネル" : "アカウント形式判別パネル";
    const setFeedback = isShadowban
      ? setShadowbanFeedback
      : kind === "2fa" ? setTotpFeedback : setFormatFeedback;

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
        <div className="section-head"><div>
          <span className="eyebrow">X UTILITY</span>
          <h2>アカウント形式判別</h2>
          <p className="muted">納品文字列をID・パスワード・メール・2FAキーなどに整理し、各項目をコピーできるパネルを設置します。</p>
        </div></div>
        <label className="field"><span>パネル設置チャンネル</span>
          {channelSelect(formatChannelId, setFormatChannelId)}
        </label>
        <div className="button-row"><button type="button" className="primary"
          disabled={busy !== null || !formatChannelId} onClick={() => void deploy("account-format")}>
          {busy === "account-format" ? "設置中..." : "アカウント形式判別パネルを設置"}
        </button></div>
        {feedback(formatFeedback)}
        <p className="muted">最初のパネルに「形式判別」「チュートリアル」の2つのボタンを表示します。入力・判別結果・2FA生成はDiscord内で完結し、結果は本人だけに表示します。表示された値をタップしてコピーできます。外部ページへの誘導はありません。</p>
      </article>
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

        <div className="section-head">
          <div>
            <span className="eyebrow">X SEARCH SESSION</span>
            <h3>X検索用ログイン情報</h3>
            <p className="muted">
              Search Ban / Search Suggestion Banの確認に使います。
              チェック専用のXアカウントを推奨します。
            </p>
          </div>
          <strong>
            {credentialStatus.configured ? "設定済み" : "未設定"}
          </strong>
        </div>

        <label className="field">
          <span>auth_token</span>
          <input
            type="password"
            value={authToken}
            autoComplete="off"
            placeholder={
              credentialStatus.configured
                ? "変更する場合のみ入力"
                : "auth_token を入力"
            }
            onChange={(event) => setAuthToken(event.target.value)}
          />
        </label>

        <label className="field">
          <span>ct0</span>
          <input
            type="password"
            value={ct0}
            autoComplete="off"
            placeholder={
              credentialStatus.configured
                ? "変更する場合のみ入力"
                : "ct0 を入力"
            }
            onChange={(event) => setCt0(event.target.value)}
          />
        </label>

        {credentialStatus.updatedAt && (
          <p className="muted">
            最終更新: {new Date(credentialStatus.updatedAt).toLocaleString("ja-JP")}
          </p>
        )}

        <div className="button-row">
          <button
            type="button"
            className="primary"
            disabled={credentialBusy}
            onClick={() => void saveCredential()}
          >
            {credentialBusy ? "処理中..." : "ログイン情報を保存"}
          </button>
          {credentialStatus.configured && (
            <button
              type="button"
              disabled={credentialBusy}
              onClick={() => void clearCredential()}
            >
              保存済み情報を削除
            </button>
          )}
        </div>
        {feedback(credentialFeedback)}

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
