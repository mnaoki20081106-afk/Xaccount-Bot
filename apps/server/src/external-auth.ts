import { pool } from "./db.js";
import { randomUUID } from "node:crypto";

export type ExternalAuth = {
  id: string;
  guild_id: string;
  name: string;
  url: string;
  created_at: Date;
};

export async function ensureExternalAuthTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS external_auths (
      id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS external_auths_guild_idx ON external_auths(guild_id);
  `);
}

export async function listExternalAuths(guildId: string): Promise<ExternalAuth[]> {
  await ensureExternalAuthTable();
  const result = await pool.query<ExternalAuth>(
    "SELECT * FROM external_auths WHERE guild_id=$1 ORDER BY created_at DESC",
    [guildId]
  );
  return result.rows;
}

export async function createExternalAuth(guildId: string, name: string, url: string): Promise<ExternalAuth> {
  await ensureExternalAuthTable();
  const id = randomUUID();
  const result = await pool.query<ExternalAuth>(
    "INSERT INTO external_auths(id, guild_id, name, url) VALUES ($1, $2, $3, $4) RETURNING *",
    [id, guildId, name, url]
  );
  return result.rows[0]!;
}

export async function deleteExternalAuth(guildId: string, id: string): Promise<boolean> {
  await ensureExternalAuthTable();
  const result = await pool.query(
    "DELETE FROM external_auths WHERE guild_id=$1 AND id=$2",
    [guildId, id]
  );
  return (result.rowCount ?? 0) === 1;
}
