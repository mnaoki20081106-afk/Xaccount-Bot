import { FormEvent, useEffect, useState } from "react";
import { api } from "./api";

type ExternalAuth = {
  id: string;
  name: string;
  url: string;
};

export default function ExternalAuthManager({ guildId }: { guildId: string }) {
  const [auths, setAuths] = useState<ExternalAuth[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!guildId) return;
    setBusy(true);
    try {
      const rows = await api<ExternalAuth[]>(`/api/guilds/${guildId}/external-auths`);
      setAuths(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [guildId]);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !url.trim()) return;
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/external-auths`, {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), url: url.trim() })
      });
      setName("");
      setUrl("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      await api(`/api/guilds/${guildId}/external-auths/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!guildId) return null;

  return (
    <div className="panel" style={{ marginTop: 24 }}>
      <h3>他Bot 一括認証リンク管理</h3>
      <div style={{
        background: "#1e2d4a",
        border: "1px solid #2d4a7a",
        borderRadius: 10,
        padding: "12px 16px",
        marginBottom: 16,
        fontSize: 13,
        lineHeight: 1.6,
        color: "#c7d7f0"
      }}>
        <strong style={{ color: "#60a5fa" }}>⚠️ 一括認証について</strong><br />
        ここに登録したBotは、メンバーが「Discordで認証」ボタンを押して認証を完了したとき、
        <strong style={{ color: "#f0c060" }}>1回のボタン操作で全Botの認証ページが同時に開きます。</strong><br />
        メンバーには「このボタン1回で以下の全Botへの認証が行われます」と明示されます。<br />
        追加できるのは <code>https://discord.com/oauth2/authorize?...</code> 形式のURLのみです。
      </div>
      <form onSubmit={add} style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          placeholder="識別名（例: BedrockAA）"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          style={{ flex: 1 }}
        />
        <input
          placeholder="https://discord.com/oauth2/authorize?..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          required
          style={{ flex: 2 }}
        />
        <button type="submit" disabled={busy}>追加</button>
      </form>
      {error && <p style={{ color: "#ef4444" }}>{error}</p>}
      {auths.length > 0 && (
        <p style={{ fontSize: 12, color: "#6b7aa0", marginBottom: 8 }}>
          現在 {auths.length} 個のBotが登録されています。認証時に全て一括で開かれます。
        </p>
      )}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {auths.map((a) => (
          <li key={a.id} style={{ padding: "8px 0", borderBottom: "1px solid #333", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>{a.name}</strong>
              <br />
              <small style={{ color: "#aaa" }}>{a.url.slice(0, 80)}{a.url.length > 80 ? "…" : ""}</small>
            </div>
            <button onClick={() => remove(a.id)} disabled={busy} style={{ marginLeft: 12 }}>削除</button>
          </li>
        ))}
      </ul>
      {auths.length === 0 && <p style={{ color: "#888" }}>登録なし（登録したBotは認証完了後に一括で開かれます）</p>}
    </div>
  );
}
