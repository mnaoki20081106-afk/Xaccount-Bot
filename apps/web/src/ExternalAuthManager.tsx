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
      <h3>他Bot認証リンク管理</h3>
      <p style={{ fontSize: 13, color: "#888", marginBottom: 12 }}>
        登録したURLは認証完了時に一括で処理されます。
      </p>
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
      <ul style={{ listStyle: "none", padding: 0 }}>
        {auths.map((a) => (
          <li key={a.id} style={{ padding: "8px 0", borderBottom: "1px solid #333", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <strong>{a.name}</strong>
              <br />
              <small style={{ color: "#aaa" }}>{a.url.slice(0, 100)}...</small>
            </div>
            <button onClick={() => remove(a.id)} disabled={busy} style={{ marginLeft: 12 }}>削除</button>
          </li>
        ))}
      </ul>
      {auths.length === 0 && <p style={{ color: "#888" }}>登録なし</p>}
    </div>
  );
}
