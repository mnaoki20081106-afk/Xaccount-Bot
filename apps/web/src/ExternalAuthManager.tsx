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

  return (
    <div className="panel">
      <h3>他bot認証リンク管理</h3>
      <form onSubmit={add} className="stack">
        <input placeholder="識別名" value={name} onChange={(e) => setName(e.target.value)} required />
        <input placeholder="OAuth URL" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <button type="submit" disabled={busy}>追加</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul>
        {auths.map((a) => (
          <li key={a.id}>
            <strong>{a.name}</strong>
            <br />
            <small>{a.url.slice(0, 80)}...</small>
            <button onClick={() => remove(a.id)} disabled={busy}>削除</button>
          </li>
        ))}
      </ul>
      {auths.length === 0 && <p>登録なし</p>}
    </div>
  );
}
