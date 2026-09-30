import type { Env } from "./types";
import { decrypt, encrypt } from "./utils";

export type XUtilitySearchSession = {
  session: string;
  csrf: string;
  updatedAt: number;
};

export async function getXUtilitySearchStatus(env: Env): Promise<{
  configured: boolean;
  updatedAt: number | null;
}> {
  const row = await env.DB.prepare(
    "SELECT updated_at FROM xutility_search_session WHERE id=1"
  ).first<{updated_at:number}>();
  return {
    configured: Boolean(row),
    updatedAt: row ? Number(row.updated_at) : null
  };
}

export async function saveXUtilitySearchSession(
  env: Env,
  input: { session: string; csrf: string }
): Promise<{ configured: true; updatedAt: number }> {
  const session = input.session.trim();
  const csrf = input.csrf.trim();
  if (!session || !csrf) throw new Error("X検索用ログイン情報を両方入力してください");
  if (session.length > 2048 || csrf.length > 2048) {
    throw new Error("X検索用ログイン情報が長すぎます");
  }

  const updatedAt = Date.now();
  const [sessionEnc, csrfEnc] = await Promise.all([
    encrypt(env.SESSION_ENCRYPTION_KEY, session),
    encrypt(env.SESSION_ENCRYPTION_KEY, csrf)
  ]);

  await env.DB.prepare(
    `INSERT INTO xutility_search_session(id,session_enc,csrf_enc,updated_at)
     VALUES(1,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       session_enc=excluded.session_enc,
       csrf_enc=excluded.csrf_enc,
       updated_at=excluded.updated_at`
  ).bind(sessionEnc, csrfEnc, updatedAt).run();

  return { configured: true, updatedAt };
}

export async function loadXUtilitySearchSession(
  env: Env
): Promise<XUtilitySearchSession | null> {
  const row = await env.DB.prepare(
    "SELECT session_enc,csrf_enc,updated_at FROM xutility_search_session WHERE id=1"
  ).first<{session_enc:string;csrf_enc:string;updated_at:number}>();
  if (!row) return null;
  const [session, csrf] = await Promise.all([
    decrypt(env.SESSION_ENCRYPTION_KEY, row.session_enc),
    decrypt(env.SESSION_ENCRYPTION_KEY, row.csrf_enc)
  ]);
  return { session, csrf, updatedAt: Number(row.updated_at) };
}

export async function clearXUtilitySearchSession(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM xutility_search_session WHERE id=1").run();
}
