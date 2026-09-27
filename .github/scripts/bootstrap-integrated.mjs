import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const securitySource = "/tmp/discord-security/src";

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}
function write(rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}
function replaceRequired(text, from, to, label) {
  if (!text.includes(from)) {
    throw new Error("Required patch target not found: " + label);
  }
  return text.replace(from, to);
}

fs.rmSync(path.join(root, "apps/web/public/CNAME"), { force: true });

const securityDir = path.join(root, "apps/worker/src/security");
fs.mkdirSync(securityDir, { recursive: true });
for (const name of ["db.ts", "discord.ts", "engine.ts", "gateway.ts", "types.ts"]) {
  fs.copyFileSync(path.join(securitySource, name), path.join(securityDir, name));
}
fs.copyFileSync(path.join(securitySource, "index.ts"), path.join(securityDir, "service.ts"));

let mainTypes = read("apps/worker/src/types.ts");
mainTypes = replaceRequired(
  mainTypes,
  "  DISCORD_GATEWAY: DurableObjectNamespace;\n",
  "  DISCORD_GATEWAY: DurableObjectNamespace;\n  SECURITY_GATEWAY: DurableObjectNamespace;\n",
  "main Env SECURITY_GATEWAY"
);
mainTypes = replaceRequired(
  mainTypes,
  "  DISCORD_APPLICATION_ID: string;\n",
  "  DISCORD_APPLICATION_ID: string;\n  MAIN_BOT_APPLICATION_ID?: string;\n",
  "main Env MAIN_BOT_APPLICATION_ID"
);
write("apps/worker/src/types.ts", mainTypes);

let securityTypes = read("apps/worker/src/security/types.ts");
securityTypes = securityTypes.replace(
  "  SECURITY_BRIDGE_SECRET: string;",
  "  SECURITY_BRIDGE_SECRET?: string;"
);
write("apps/worker/src/security/types.ts", securityTypes);

for (const rel of [
  "apps/worker/src/security/engine.ts",
  "apps/worker/src/security/discord.ts",
  "apps/worker/src/security/db.ts",
  "apps/worker/src/security/gateway.ts"
]) {
  let text = read(rel);
  text = text.replaceAll(
    "this.env.MAIN_BOT_APPLICATION_ID?.trim()",
    "(this.env.MAIN_BOT_APPLICATION_ID ?? this.env.DISCORD_APPLICATION_ID)?.trim()"
  );
  text = text.replaceAll(
    "env.MAIN_BOT_APPLICATION_ID?.trim()",
    "(env.MAIN_BOT_APPLICATION_ID ?? env.DISCORD_APPLICATION_ID)?.trim()"
  );
  write(rel, text);
}

let service = read("apps/worker/src/security/service.ts");
service = replaceRequired(
  service,
  `export function isConfiguredMainBot(
  env: Pick<Env, "MAIN_BOT_APPLICATION_ID">,
  candidateId: string
): boolean {
  const expected = String(env.MAIN_BOT_APPLICATION_ID ?? "").trim();
  return /^\\d+$/.test(expected) && candidateId === expected;
}
`,
  `function effectiveMainBotApplicationId(env: Pick<Env, "MAIN_BOT_APPLICATION_ID" | "DISCORD_APPLICATION_ID">): string {
  return String(env.MAIN_BOT_APPLICATION_ID ?? env.DISCORD_APPLICATION_ID ?? "").trim();
}

export function isConfiguredMainBot(
  env: Pick<Env, "MAIN_BOT_APPLICATION_ID" | "DISCORD_APPLICATION_ID">,
  candidateId: string
): boolean {
  const expected = effectiveMainBotApplicationId(env);
  return /^\\d+$/.test(expected) && candidateId === expected;
}
`,
  "security service main bot identity"
);
service = service.replaceAll(
  "env.MAIN_BOT_APPLICATION_ID?.trim()",
  "effectiveMainBotApplicationId(env)"
);
service = service.replaceAll(
  "String(env.MAIN_BOT_APPLICATION_ID ?? \"\").trim()",
  "effectiveMainBotApplicationId(env)"
);
service = service.replaceAll(
  "env.MAIN_BOT_APPLICATION_ID.trim()",
  "effectiveMainBotApplicationId(env)"
);
service += `

export async function handleIntegratedSecurityRequest(
  request: Request,
  env: Env
): Promise<Response> {
  const integratedEnv: Env = {
    ...env,
    MAIN_BOT_APPLICATION_ID: effectiveMainBotApplicationId(env)
  };
  const bodyText = request.method === "GET" ? "" : await request.text();
  await ensureSchema(integratedEnv);
  await ensureDiscordSecurityGateway(integratedEnv);
  try {
    return await handleInternal(request, integratedEnv, bodyText);
  } catch (error) {
    console.error("integrated security API failed", error);
    return json({
      error: "server_error",
      message: error instanceof Error ? error.message : "unknown error"
    }, 500);
  }
}

export async function runIntegratedSecurityScheduled(env: Env): Promise<void> {
  const integratedEnv: Env = {
    ...env,
    MAIN_BOT_APPLICATION_ID: effectiveMainBotApplicationId(env)
  };
  await ensureSchema(integratedEnv);
  await cleanExpired(integratedEnv);
  await ensureDiscordSecurityGateway(integratedEnv);
  await reconcileDiscordSecurityAudits(integratedEnv).catch(error => {
    console.error("integrated security audit reconciliation failed", error);
  });
  for (const guildId of await listExpiredLockdowns(integratedEnv)) {
    await exitLockdown(integratedEnv, guildId).catch(error => {
      console.error("integrated lockdown restore failed", guildId, error);
    });
  }
}
`;
write("apps/worker/src/security/service.ts", service);

write("apps/worker/src/security-bridge.ts", "import type { Env } from \"./types\";\nimport { handleIntegratedSecurityRequest } from \"./security/service\";\n\nfunction normalizeSecurityApiBaseUrl(raw?: string): string | null {\n  let value = raw?.trim() ?? \"\";\n  if (!value) return null;\n  if (\n    (value.startsWith('\"') && value.endsWith('\"')) ||\n    (value.startsWith(\"'\") && value.endsWith(\"'\"))\n  ) {\n    value = value.slice(1, -1).trim();\n  }\n  value = value.replace(/^SECURITY_API_BASE_URL\\s*=\\s*/i, \"\").trim();\n  if (!value) return null;\n  if (!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(value)) {\n    value = \"https://\" + value;\n  }\n  try {\n    const url = new URL(value);\n    if (url.protocol !== \"https:\" && url.protocol !== \"http:\") return null;\n    if (!url.hostname) return null;\n    url.hash = \"\";\n    url.search = \"\";\n    url.pathname = url.pathname.replace(/\\/+$/, \"\") + \"/\";\n    return url.toString();\n  } catch {\n    return null;\n  }\n}\n\nfunction localSecurityConfigured(env: Env): boolean {\n  return Boolean(\n    env.SECURITY_GATEWAY &&\n    env.DISCORD_BOT_TOKEN?.trim() &&\n    env.DISCORD_APPLICATION_ID?.trim()\n  );\n}\n\nfunction legacySecurityConfigured(env: Env): boolean {\n  return Boolean(\n    normalizeSecurityApiBaseUrl(env.SECURITY_API_BASE_URL) &&\n    env.SECURITY_BRIDGE_SECRET?.trim() &&\n    env.SECURITY_BRIDGE_SECRET.trim().length >= 32\n  );\n}\n\nexport function securityBridgeConfigured(env: Env): boolean {\n  return localSecurityConfigured(env) || legacySecurityConfigured(env);\n}\n\nfunction hex(bytes: ArrayBuffer): string {\n  return [...new Uint8Array(bytes)]\n    .map(value => value.toString(16).padStart(2, \"0\"))\n    .join(\"\");\n}\n\nasync function hmacHex(secret: string, value: string): Promise<string> {\n  const key = await crypto.subtle.importKey(\n    \"raw\",\n    new TextEncoder().encode(secret),\n    { name: \"HMAC\", hash: \"SHA-256\" },\n    false,\n    [\"sign\"]\n  );\n  return hex(await crypto.subtle.sign(\n    \"HMAC\",\n    key,\n    new TextEncoder().encode(value)\n  ));\n}\n\nexport async function securityBridgeFetch(\n  env: Env,\n  path: string,\n  init: RequestInit = {}\n): Promise<Response> {\n  const method = String(init.method ?? \"GET\").toUpperCase();\n\n  if (localSecurityConfigured(env)) {\n    const url = new URL(\n      path.replace(/^\\//, \"\"),\n      \"https://integrated-security.internal/\"\n    );\n    const request = new Request(url.toString(), {\n      ...init,\n      method,\n      body: method === \"GET\" || method === \"HEAD\" ? undefined : init.body,\n      headers: {\n        \"Content-Type\": \"application/json\",\n        ...(init.headers ?? {})\n      }\n    });\n    return handleIntegratedSecurityRequest(request, env);\n  }\n\n  if (!legacySecurityConfigured(env)) {\n    throw new Error(\"Integrated Security is not configured\");\n  }\n\n  const base = normalizeSecurityApiBaseUrl(env.SECURITY_API_BASE_URL);\n  if (!base) throw new Error(\"SECURITY_API_BASE_URL is invalid\");\n\n  const url = new URL(path.replace(/^\\//, \"\"), base);\n  const body =\n    typeof init.body === \"string\"\n      ? init.body\n      : init.body == null\n        ? \"\"\n        : String(init.body);\n  const timestamp = String(Date.now());\n  const nonce = crypto.randomUUID().replace(/-/g, \"\");\n  const canonical =\n    timestamp + \"\\n\" +\n    nonce + \"\\n\" +\n    method + \"\\n\" +\n    url.pathname + url.search + \"\\n\" +\n    body;\n  const signature = await hmacHex(env.SECURITY_BRIDGE_SECRET!, canonical);\n  const request = new Request(url.toString(), {\n    ...init,\n    method,\n    body: body || undefined,\n    headers: {\n      \"Content-Type\": \"application/json\",\n      \"X-Security-Timestamp\": timestamp,\n      \"X-Security-Nonce\": nonce,\n      \"X-Security-Signature\": signature,\n      ...(init.headers ?? {})\n    }\n  });\n  if (env.SECURITY_SERVICE) return env.SECURITY_SERVICE.fetch(request);\n  return fetch(request);\n}\n\nexport async function securityBridgeJson<T>(\n  env: Env,\n  path: string,\n  init: RequestInit = {}\n): Promise<T> {\n  const response = await securityBridgeFetch(env, path, init);\n  const text = await response.text();\n  if (!response.ok) {\n    let message = text;\n    try {\n      const parsed = JSON.parse(text) as { message?: string; error?: string };\n      message = parsed.message ?? parsed.error ?? text;\n    } catch {\n      // keep raw text\n    }\n    throw new Error(\n      (localSecurityConfigured(env) ? \"Integrated Security API \" : \"Security Bot API \") +\n      response.status + \": \" + message.slice(0, 300)\n    );\n  }\n  return text ? JSON.parse(text) as T : undefined as T;\n}\n\nexport async function openSecurityMaintenanceLease(\n  env: Env,\n  guildId: string,\n  scope: \"dashboard_edit\" | \"restore\",\n  seconds: number\n): Promise<{ id: string; expiresAt: number } | null> {\n  if (!securityBridgeConfigured(env)) return null;\n  return securityBridgeJson(env, \"/internal/guilds/\" + guildId + \"/maintenance\", {\n    method: \"POST\",\n    body: JSON.stringify({\n      actorId: env.DISCORD_APPLICATION_ID,\n      scope,\n      seconds\n    })\n  });\n}\n");

let mainIndex = read("apps/worker/src/index.ts");
mainIndex = replaceRequired(
  mainIndex,
  'import { ensureDiscordGateway } from "./discord-gateway";\nexport { DiscordGateway } from "./discord-gateway";\n',
  'import { ensureDiscordGateway } from "./discord-gateway";\nimport { ensureDiscordSecurityGateway } from "./security/gateway";\nimport { runIntegratedSecurityScheduled } from "./security/service";\nexport { DiscordGateway } from "./discord-gateway";\nexport { DiscordSecurityGateway } from "./security/gateway";\n',
  "main security imports"
);
mainIndex = replaceRequired(
  mainIndex,
  '      const url=new URL(request.url);\n\n      if(request.method==="OPTIONS"){',
  '      const url=new URL(request.url);\n      if(env.SECURITY_GATEWAY){\n        ctx.waitUntil(ensureDiscordSecurityGateway(env).catch(error=>console.error("integrated security gateway start failed",error)));\n      }\n\n      if(request.method==="OPTIONS"){',
  "main fetch security startup"
);
mainIndex = replaceRequired(
  mainIndex,
  '      ensureDiscordGateway(env),\n      botAccessGuardSweep(env),',
  '      ensureDiscordGateway(env),\n      env.SECURITY_GATEWAY?runIntegratedSecurityScheduled(env):Promise.resolve(),\n      botAccessGuardSweep(env),',
  "main scheduled security"
);
mainIndex = replaceRequired(
  mainIndex,
  "  const verifyPanel=url.pathname.match(/^\\/api\\/guilds\\/(\\d+)\\/verification\\/panel$/);\n  if(verifyPanel&&request.method===\"POST\"){\n    const guildId=verifyPanel[1]!;\n    await requireGuild(request,env,guildId);\n    await ensureSchema(env);\n    const verificationSettings=await getGuildSettings(env,guildId);\n    if(!verificationSettings.verifiedRoleId){\n      throw new HttpError(409,\"先に「認証後ロール」を設定して保存してください\");\n    }\n    const {channelId}=await bodyObject<{channelId?:string}>(request);\n    if(!channelId) throw new HttpError(400,\"設置先チャンネルを選択してください\");\n    await requireMessageChannel(env,guildId,channelId);\n    try{\n      await publishVerificationPanel(env,guildId,channelId,new URL(request.url).origin);\n    }catch(error){\n      if(error instanceof DiscordApiError&&error.status===404){\n        throw new HttpError(404,\"設置先チャンネルが見つかりません。チャンネル一覧を再読み込みしてください\");\n      }\n      if(error instanceof DiscordApiError&&error.status===429){\n        throw new HttpError(429,\"Discord APIのレート制限中です。少し待ってからもう一度設置してください\");\n      }\n      throw error;\n    }\n    return json(env,{ok:true,channelId});\n  }",
  "  const verifyPanel=url.pathname.match(/^\\/api\\/guilds\\/(\\d+)\\/verification\\/panel$/);\n  if(verifyPanel&&request.method===\"POST\"){\n    const guildId=verifyPanel[1]!;\n    await requireGuild(request,env,guildId);\n    await ensureSchema(env);\n    const input=await bodyObject<{channelId?:string;verifiedRoleId?:string|null}>(request);\n    const requestedVerifiedRoleId=\n      typeof input.verifiedRoleId===\"string\"&&/^\\d+$/.test(input.verifiedRoleId.trim())\n        ?input.verifiedRoleId.trim()\n        :null;\n    let verificationSettings=await getGuildSettings(env,guildId);\n\n    // Keep panel deployment consistent with the role currently selected in the dashboard.\n    // Without this, a fast click after Save can race the settings PUT and read stale D1 state.\n    if(requestedVerifiedRoleId&&requestedVerifiedRoleId!==verificationSettings.verifiedRoleId){\n      const roles=await botJson<DiscordRole[]>(env,`/guilds/${guildId}/roles`);\n      const targetRole=roles.find(role=>role.id===requestedVerifiedRoleId);\n      if(!targetRole||targetRole.id===guildId){\n        throw new HttpError(400,\"認証後ロールには@everyone以外の有効なロールを選択してください\");\n      }\n      if(targetRole.managed){\n        throw new HttpError(400,\"Discord管理ロールは認証後ロールに指定できません\");\n      }\n      if((BigInt(targetRole.permissions||\"0\")&DANGEROUS_PERMISSION_MASK)!==0n){\n        throw new HttpError(400,\"認証後ロールに管理者・ロール管理・チャンネル管理・BAN/Kickなどの危険権限は設定できません\");\n      }\n      await saveGuildSettings(env,guildId,{verifiedRoleId:requestedVerifiedRoleId});\n      verificationSettings=await getGuildSettings(env,guildId);\n    }\n\n    if(!verificationSettings.verifiedRoleId){\n      throw new HttpError(409,\"認証後ロールを選択してから認証パネルを設置してください\");\n    }\n    const channelId=input.channelId;\n    if(!channelId) throw new HttpError(400,\"設置先チャンネルを選択してください\");\n    await requireMessageChannel(env,guildId,channelId);\n    try{\n      await publishVerificationPanel(env,guildId,channelId,new URL(request.url).origin);\n    }catch(error){\n      if(error instanceof DiscordApiError&&error.status===404){\n        throw new HttpError(404,\"設置先チャンネルが見つかりません。チャンネル一覧を再読み込みしてください\");\n      }\n      if(error instanceof DiscordApiError&&error.status===429){\n        throw new HttpError(429,\"Discord APIのレート制限中です。少し待ってからもう一度設置してください\");\n      }\n      throw error;\n    }\n    return json(env,{ok:true,channelId,verifiedRoleId:verificationSettings.verifiedRoleId});\n  }",
  "verification panel role sync"
);
write("apps/worker/src/index.ts", mainIndex);

write("apps/worker/wrangler.jsonc", `{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "xaccount-bot",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],
  "workers_dev": true,
  "preview_urls": true,
  "durable_objects": {
    "bindings": [
      {
        "name": "DISCORD_GATEWAY",
        "class_name": "DiscordGateway"
      },
      {
        "name": "SECURITY_GATEWAY",
        "class_name": "DiscordSecurityGateway"
      }
    ]
  },
  "migrations": [
    {
      "tag": "discord-gateway-v1",
      "new_sqlite_classes": ["DiscordGateway"]
    },
    {
      "tag": "integrated-security-gateway-v1",
      "new_sqlite_classes": ["DiscordSecurityGateway"]
    }
  ],
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "xaccount-bot-db",
      "database_id": "284a6d6b-0dc5-479f-ba0e-86eb445df2cd"
    }
  ],
  "triggers": {
    "crons": ["* * * * *"]
  },
  "vars": {
    "WEB_ORIGIN": "https://mnaoki20081106-afk.github.io",
    "WEB_PUBLIC_URL": "https://mnaoki20081106-afk.github.io/Xaccount-Bot/",
    "PAYPAY_ENV": "sandbox"
  }
}
`);

let dashboardApp = read("apps/web/src/App.tsx");
dashboardApp = replaceRequired(
  dashboardApp,
  "  async function postPanel(kind: \"verification\" | \"tickets\") {\n    const label = kind === \"verification\" ? \"認証パネル\" : \"Ticketパネル\";\n    const channelId =\n      kind === \"verification\" ? verificationPanelChannel : ticketPanelChannel;\n    const setFeedback =\n      kind === \"verification\" ? setVerificationPanelFeedback : setTicketPanelFeedback;\n\n    if (!selectedId) {\n      setFeedback({ kind: \"error\", message: \"サーバーを選択してください\" });\n      return;\n    }\n    if (!channelId) {\n      setFeedback({\n        kind: \"error\",\n        message:\n          \"BOTが投稿できるテキストチャンネルがありません。BOT権限を更新してください\"\n      });\n      return;\n    }\n\n    const selectedPanelChannel =\n      meta?.channels.find((channel) => channel.id === channelId) ?? null;\n    if (selectedPanelChannel?.botCanPost === false) {\n      setFeedback({\n        kind: \"error\",\n        message:\n          \"このチャンネルではBOTの閲覧・送信・埋め込み権限が拒否されています。BOT権限を更新するか、投稿可能なチャンネルを選択してください\"\n      });\n      return;\n    }\n\n    setBusy(true);\n    setPanelAction(kind);\n    setFeedback({ kind: \"info\", message: label + \"をDiscordへ送信中...\" });\n    setError(null);\n    try {\n      await api(`/api/guilds/${selectedId}/${kind}/panel`, {\n        method: \"POST\",\n        body: JSON.stringify({ channelId })\n      });\n      const channelName =\n        meta?.channels.find((channel) => channel.id === channelId)?.name ?? channelId;\n      setFeedback({\n        kind: \"success\",\n        message: label + \"を #\" + channelName + \" に設置しました\"\n      });\n      flash(label + \"を設置しました\");\n    } catch (reason) {\n      const message = reason instanceof Error ? reason.message : String(reason);\n      setFeedback({\n        kind: \"error\",\n        message: label + \"の設置に失敗しました: \" + message\n      });\n    } finally {\n      setPanelAction(null);\n      setBusy(false);\n    }\n  }",
  "  async function postPanel(kind: \"verification\" | \"tickets\") {\n    const label = kind === \"verification\" ? \"認証パネル\" : \"Ticketパネル\";\n    const channelId =\n      kind === \"verification\" ? verificationPanelChannel : ticketPanelChannel;\n    const setFeedback =\n      kind === \"verification\" ? setVerificationPanelFeedback : setTicketPanelFeedback;\n\n    if (!selectedId) {\n      setFeedback({ kind: \"error\", message: \"サーバーを選択してください\" });\n      return;\n    }\n    if (kind === \"verification\" && !settings?.verifiedRoleId) {\n      setFeedback({ kind: \"error\", message: \"先に認証後ロールを選択してください\" });\n      return;\n    }\n    if (!channelId) {\n      setFeedback({\n        kind: \"error\",\n        message:\n          \"BOTが投稿できるテキストチャンネルがありません。BOT権限を更新してください\"\n      });\n      return;\n    }\n\n    const selectedPanelChannel =\n      meta?.channels.find((channel) => channel.id === channelId) ?? null;\n    if (selectedPanelChannel?.botCanPost === false) {\n      setFeedback({\n        kind: \"error\",\n        message:\n          \"このチャンネルではBOTの閲覧・送信・埋め込み権限が拒否されています。BOT権限を更新するか、投稿可能なチャンネルを選択してください\"\n      });\n      return;\n    }\n\n    setBusy(true);\n    setPanelAction(kind);\n    setFeedback({ kind: \"info\", message: label + \"をDiscordへ送信中...\" });\n    setError(null);\n    try {\n      await api(`/api/guilds/${selectedId}/${kind}/panel`, {\n        method: \"POST\",\n        body: JSON.stringify({\n          channelId,\n          ...(kind === \"verification\"\n            ? { verifiedRoleId: settings?.verifiedRoleId ?? null }\n            : {})\n        })\n      });\n      const channelName =\n        meta?.channels.find((channel) => channel.id === channelId)?.name ?? channelId;\n      setFeedback({\n        kind: \"success\",\n        message: label + \"を #\" + channelName + \" に設置しました\"\n      });\n      flash(label + \"を設置しました\");\n    } catch (reason) {\n      const message = reason instanceof Error ? reason.message : String(reason);\n      setFeedback({\n        kind: \"error\",\n        message: label + \"の設置に失敗しました: \" + message\n      });\n    } finally {\n      setPanelAction(null);\n      setBusy(false);\n    }\n  }",
  "verification panel UI request sync"
);
dashboardApp = replaceRequired(
  dashboardApp,
  "                  <button\n                  type=\"button\"\n                  className=\"primary\"\n                  disabled={\n                  panelAction !== null ||\n                  !verificationPanelChannel ||\n                  selectedVerificationChannel?.botCanPost === false\n                  }\n                  onClick={() => void postPanel(\"verification\")}\n                  >\n                  {panelAction === \"verification\" ? \"設置中...\" : \"認証パネルを設置\"}",
  "                  <button\n                  type=\"button\"\n                  className=\"primary\"\n                  disabled={\n                  busy ||\n                  panelAction !== null ||\n                  !settings.verifiedRoleId ||\n                  !verificationPanelChannel ||\n                  selectedVerificationChannel?.botCanPost === false\n                  }\n                  onClick={() => void postPanel(\"verification\")}\n                  >\n                  {panelAction === \"verification\" ? \"設置中...\" : \"認証パネルを設置\"}",
  "verification panel UI busy state"
);
write("apps/web/src/App.tsx", dashboardApp);

let dashboardTest = read("apps/worker/test/dashboard.test.mjs");
dashboardTest = replaceRequired(
  dashboardTest,
  "test('verification panel deployment points directly to unified oauth', async t => {\n  const {mf,calls,db} = await runtime(t);\n  const login = await request(mf, '/api/login', null, 'POST', {\n    password:'local-test-password'\n  });\n  assert.equal(login.status,200);\n  const token=login.body.token;\n\n  const rejected=await request(\n    mf,\n    `/api/guilds/${guildId}/verification/panel`,\n    token,\n    'POST',\n    {channelId:chatChannelId}\n  );\n  assert.equal(rejected.status,409,JSON.stringify(rejected.body));\n  assert.match(rejected.body.message,/認証後ロール/);\n  assert.equal(\n    calls.some(call=>call.method==='POST'&&call.path===`/api/v10/channels/${chatChannelId}/messages`),\n    false,\n    'an unusable verification panel must not be posted'\n  );\n\n  const settings=await request(\n    mf,\n    `/api/guilds/${guildId}/settings`,\n    token,\n    'PUT',\n    {verifiedRoleId:targetRoleId,minAccountAgeDays:0}\n  );\n  assert.equal(settings.status,200,JSON.stringify(settings.body));\n\n  const deployed=await request(\n    mf,\n    `/api/guilds/${guildId}/verification/panel`,\n    token,\n    'POST',\n    {channelId:chatChannelId}\n  );\n  assert.equal(deployed.status,200,JSON.stringify(deployed.body));\n\n  const post=calls.find(call=>\n    call.method==='POST'&&call.path===`/api/v10/channels/${chatChannelId}/messages`\n  );\n  assert.ok(post?.body,'verification panel payload must be sent to Discord');\n  const button=post.body.components?.[0]?.components?.[0];\n  assert.equal(button?.style,5);\n  assert.equal(button?.custom_id,undefined);\n  const panelUrl=new URL(button?.url);\n  assert.equal(panelUrl.origin,'https://worker.example');\n  assert.equal(panelUrl.pathname,'/auth/verification/start');\n  assert.equal(panelUrl.searchParams.get('guild_id'),guildId);\n  assert.match(post.body.embeds?.[0]?.description??'',/復旧/);\n\n  const deployment=await db.prepare(\n    \"SELECT channel_id,message_id FROM panel_deployments WHERE guild_id=? AND kind='verification'\"\n  ).bind(guildId).first();\n  assert.equal(deployment?.channel_id,chatChannelId);\n  assert.ok(deployment?.message_id);\n});",
  "test('verification panel deployment points directly to unified oauth', async t => {\n  const {mf,calls,db} = await runtime(t);\n  const login = await request(mf, '/api/login', null, 'POST', {\n    password:'local-test-password'\n  });\n  assert.equal(login.status,200);\n  const token=login.body.token;\n\n  const rejected=await request(\n    mf,\n    `/api/guilds/${guildId}/verification/panel`,\n    token,\n    'POST',\n    {channelId:chatChannelId}\n  );\n  assert.equal(rejected.status,409,JSON.stringify(rejected.body));\n  assert.match(rejected.body.message,/認証後ロール/);\n  assert.equal(\n    calls.some(call=>call.method==='POST'&&call.path===`/api/v10/channels/${chatChannelId}/messages`),\n    false,\n    'an unusable verification panel must not be posted'\n  );\n\n  // The selected role can arrive with the panel request if the user clicks\n  // immediately after changing/saving the setting. It must be persisted first.\n  const deployed=await request(\n    mf,\n    `/api/guilds/${guildId}/verification/panel`,\n    token,\n    'POST',\n    {channelId:chatChannelId,verifiedRoleId:targetRoleId}\n  );\n  assert.equal(deployed.status,200,JSON.stringify(deployed.body));\n  assert.equal(deployed.body.verifiedRoleId,targetRoleId);\n\n  const persistedSettings=await request(\n    mf,\n    `/api/guilds/${guildId}/settings`,\n    token\n  );\n  assert.equal(persistedSettings.status,200,JSON.stringify(persistedSettings.body));\n  assert.equal(persistedSettings.body.verifiedRoleId,targetRoleId);\n\n  const post=calls.find(call=>\n    call.method==='POST'&&call.path===`/api/v10/channels/${chatChannelId}/messages`\n  );\n  assert.ok(post?.body,'verification panel payload must be sent to Discord');\n  const button=post.body.components?.[0]?.components?.[0];\n  assert.equal(button?.style,5);\n  assert.equal(button?.custom_id,undefined);\n  const panelUrl=new URL(button?.url);\n  assert.equal(panelUrl.origin,'https://worker.example');\n  assert.equal(panelUrl.pathname,'/auth/verification/start');\n  assert.equal(panelUrl.searchParams.get('guild_id'),guildId);\n  assert.match(post.body.embeds?.[0]?.description??'',/復旧/);\n\n  const deployment=await db.prepare(\n    \"SELECT channel_id,message_id FROM panel_deployments WHERE guild_id=? AND kind='verification'\"\n  ).bind(guildId).first();\n  assert.equal(deployment?.channel_id,chatChannelId);\n  assert.ok(deployment?.message_id);\n});",
  "verification panel save race regression"
);
write("apps/worker/test/dashboard.test.mjs", dashboardTest);

let pages = read(".github/workflows/pages.yml");
pages = pages.replace(
  "VITE_API_BASE_URL: https://discord-bot.c53gftun651-tiktok.workers.dev",
  "VITE_API_BASE_URL: ${{ vars.VITE_API_BASE_URL || \"https://xaccount-bot.mnaoki20081106.workers.dev\" }}"
);
write(".github/workflows/pages.yml", pages);

write("apps/web/vite.config.ts", `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/Xaccount-Bot/"
});
`);

let securityUi = read("apps/web/src/SecurityManager.tsx");
securityUi = securityUi
  .replaceAll("Security Botの設定を保存しました", "Security設定を保存しました")
  .replaceAll("Security Botがまだ接続されていません", "Security機能がまだ起動していません")
  .replaceAll("Security Workerの状態を確認してください。", "Security機能の状態を確認してください。")
  .replaceAll("SECURITY BOT", "SECURITY");
write("apps/web/src/SecurityManager.tsx", securityUi);

write("bot-factory.json", "{\n  \"name\": \"xaccount-bot\",\n  \"runtime\": \"worker\",\n  \"provider\": \"cloudflare\",\n  \"working_directory\": \"apps/worker\",\n  \"wrangler_config\": \"wrangler.jsonc\",\n  \"d1_migrations\": [],\n  \"d1_schema_files\": [\n    {\n      \"binding\": \"DB\",\n      \"file\": \"schema.sql\"\n    }\n  ],\n  \"setup\": {\n    \"title\": \"Xaccount-Bot\",\n    \"description\": \"Discordサーバー管理とSecurityを1つのBOTとして起動します。Discordから取得する値には取得手順を表示し、内部暗号鍵などのランダム値はFactoryが生成・暗号化保存・再利用します。初回デプロイ後は、発行されたWorker URLをDiscord Developer Portalにも設定してください。\",\n    \"fields\": [\n      {\n        \"key\": \"DISCORD_BOT_TOKEN\",\n        \"label\": \"BOT Token\",\n        \"type\": \"secret\",\n        \"required\": true,\n        \"source\": {\n          \"title\": \"BOT Tokenの取得方法\",\n          \"steps\": [\n            \"Discord Developer PortalでXaccount-Bot用Applicationを開く\",\n            \"左メニューのBotを開く\",\n            \"Token欄でReset TokenまたはCopyを押して値をコピーする\"\n          ],\n          \"url\": \"https://discord.com/developers/applications\",\n          \"link_label\": \"Discord Developer Portalを開く ↗\"\n        }\n      },\n      {\n        \"key\": \"DISCORD_APPLICATION_ID\",\n        \"label\": \"Application ID\",\n        \"type\": \"text\",\n        \"required\": true,\n        \"pattern\": \"^\\\\d{17,20}$\",\n        \"source\": {\n          \"title\": \"Application IDの取得方法\",\n          \"steps\": [\n            \"Discord Developer PortalでXaccount-Bot用Applicationを開く\",\n            \"General Informationを開く\",\n            \"Application IDのCopyを押す\"\n          ],\n          \"url\": \"https://discord.com/developers/applications\",\n          \"link_label\": \"Discord Developer Portalを開く ↗\"\n        }\n      },\n      {\n        \"key\": \"DISCORD_PUBLIC_KEY\",\n        \"label\": \"Public Key\",\n        \"type\": \"secret\",\n        \"required\": true,\n        \"source\": {\n          \"title\": \"Public Keyの取得方法\",\n          \"steps\": [\n            \"Discord Developer PortalでXaccount-Bot用Applicationを開く\",\n            \"General Informationを開く\",\n            \"Public Keyをコピーする\"\n          ],\n          \"url\": \"https://discord.com/developers/applications\",\n          \"link_label\": \"Discord Developer Portalを開く ↗\"\n        }\n      },\n      {\n        \"key\": \"DISCORD_CLIENT_SECRET\",\n        \"label\": \"Client Secret\",\n        \"type\": \"secret\",\n        \"required\": true,\n        \"source\": {\n          \"title\": \"Client Secretの取得方法\",\n          \"steps\": [\n            \"Discord Developer PortalでXaccount-Bot用Applicationを開く\",\n            \"OAuth2を開く\",\n            \"Client Secretをコピーする。表示できない場合はReset Secretを使う\"\n          ],\n          \"url\": \"https://discord.com/developers/applications\",\n          \"link_label\": \"Discord Developer Portalを開く ↗\"\n        }\n      },\n      {\n        \"key\": \"SESSION_ENCRYPTION_KEY\",\n        \"label\": \"Session Encryption Key\",\n        \"type\": \"secret\",\n        \"required\": true,\n        \"help\": \"Discord Developer Portalから取得する値ではありません。Factoryが32バイトのランダム鍵を自動生成し、暗号化保存します。このBOTではDiscord OAuthのaccess token / refresh tokenをD1へ暗号化保存するために使用します。同じBOTリポジトリ + 同じCloudflareアカウント + 同じfield keyでは再デプロイ時も同じ鍵を再利用するため、手入力や手動ローテーションは不要です。\",\n        \"generate\": {\n          \"strategy\": \"base64\",\n          \"bytes\": 32\n        }\n      },\n      {\n        \"key\": \"DASHBOARD_PASSWORD\",\n        \"label\": \"管理サイト Password\",\n        \"type\": \"secret\",\n        \"required\": true,\n        \"placeholder\": \"好きなパスワード\",\n        \"help\": \"GitHub Pagesの管理画面へログインするためのパスワードです。自分で分かる値を設定してください。\"\n      },\n      {\n        \"key\": \"SHIIRE_BRIDGE_SECRET\",\n        \"label\": \"Discord-Shiire連携 Secret\",\n        \"type\": \"secret\",\n        \"required\": false,\n        \"pattern\": \"^.{32,}$\",\n        \"placeholder\": \"Discord-Shiire側と同じ32文字以上の値\",\n        \"help\": \"仕入れBOTと連携する場合のみ入力します。別リポジトリと同じ値を共有する必要があるためFactory自動生成にはしません。\"\n      }\n    ],\n    \"discord\": {\n      \"intents\": [\n        {\n          \"id\": \"server-members-intent\",\n          \"label\": \"Server Members Intent\",\n          \"required\": true,\n          \"description\": \"入退室検知・Anti-Raid・メンバー保護に必要です。\",\n          \"path\": \"Discord Developer Portal > Bot > Privileged Gateway Intents\",\n          \"url\": \"https://discord.com/developers/applications\"\n        },\n        {\n          \"id\": \"message-content-intent\",\n          \"label\": \"Message Content Intent\",\n          \"required\": true,\n          \"description\": \"Anti-Spam・Phishing・危険リンク判定に必要です。\",\n          \"path\": \"Discord Developer Portal > Bot > Privileged Gateway Intents\",\n          \"url\": \"https://discord.com/developers/applications\"\n        }\n      ],\n      \"permissions\": [\n        {\n          \"id\": \"manage-guild\",\n          \"label\": \"サーバーの管理\",\n          \"required\": true,\n          \"description\": \"サーバー設定・監査・保護機能に使用します。\"\n        },\n        {\n          \"id\": \"manage-channels\",\n          \"label\": \"チャンネルの管理\",\n          \"required\": true,\n          \"description\": \"サーバー編集・復元・Lockdownに必要です。\"\n        },\n        {\n          \"id\": \"manage-roles\",\n          \"label\": \"ロールの管理\",\n          \"required\": true,\n          \"description\": \"認証ロール付与と危険ロール解除に必要です。\"\n        },\n        {\n          \"id\": \"kick-ban\",\n          \"label\": \"メンバーをキック / BAN\",\n          \"required\": true,\n          \"description\": \"高信頼度の悪性BOTや攻撃への対処に必要です。\"\n        },\n        {\n          \"id\": \"moderate-members\",\n          \"label\": \"メンバーをタイムアウト\",\n          \"required\": true,\n          \"description\": \"スパム・荒らしへの可逆的な制裁に必要です。\"\n        },\n        {\n          \"id\": \"manage-messages-webhooks\",\n          \"label\": \"メッセージ / Webhookの管理\",\n          \"required\": true,\n          \"description\": \"危険メッセージ削除とWebhook保護に必要です。\"\n        }\n      ],\n      \"checks\": [\n        {\n          \"id\": \"role-order-human-admin\",\n          \"label\": \"人間の管理者ロールをXaccount-Botより上に配置\",\n          \"required\": true,\n          \"description\": \"人間の管理者を自動制裁対象にせず、管理者が常にBOTを管理できる階層にします。\",\n          \"path\": \"Discord > サーバー設定 > ロール\"\n        },\n        {\n          \"id\": \"role-order-bot\",\n          \"label\": \"Xaccount-Botを操作対象ロールより上に配置\",\n          \"required\": true,\n          \"description\": \"認証ロール付与・危険ロール解除などを行えるようDiscordのロール階層制限を満たします。\",\n          \"path\": \"Discord > サーバー設定 > ロール\"\n        },\n        {\n          \"id\": \"post-deploy-interactions-url\",\n          \"label\": \"初回デプロイ後: Interactions Endpoint URLを設定\",\n          \"required\": false,\n          \"description\": \"Factoryの初回デプロイ完了後に発行されたWorkerのHTTPS URLを使い、Discord Developer Portal > General Information > Interactions Endpoint URLへ「https://<Worker URL>/interactions」を設定してSave Changesします。DiscordのSlash Commandやボタン操作を受けるために必要です。\",\n          \"path\": \"Discord Developer Portal > General Information > Interactions Endpoint URL\",\n          \"url\": \"https://discord.com/developers/applications\"\n        },\n        {\n          \"id\": \"post-deploy-oauth-redirect\",\n          \"label\": \"初回デプロイ後: OAuth2 Redirect URLを設定\",\n          \"required\": false,\n          \"description\": \"Discord Developer Portal > OAuth2 > Redirectsへ「https://<Worker URL>/auth/discord/callback」を追加してSave Changesします。認証ロール付与・復旧用OAuthで実際に使用するURLです。\",\n          \"path\": \"Discord Developer Portal > OAuth2 > Redirects\",\n          \"url\": \"https://discord.com/developers/applications\"\n        }\n      ],\n      \"notes\": [\n        \"1つのDiscord Application / 1つのBOT Tokenで管理機能とSecurity機能を動かします。\",\n        \"Security用に別BOTを追加する必要はありません。\",\n        \"SESSION_ENCRYPTION_KEYはDiscordの値ではなくFactory管理の内部暗号鍵です。Discord OAuthトークンをD1へ暗号化保存するために使い、Factoryが再デプロイ時も同じ値を再利用します。\",\n        \"Worker URLは初回デプロイ後に確定するため、Interactions Endpoint URLとOAuth2 Redirect URLはデプロイ後にDiscord Developer Portalへ設定します。\",\n        \"Interactions Endpoint URL: https://<Factoryで発行されたWorker URL>/interactions\",\n        \"OAuth2 Redirect URL: https://<Factoryで発行されたWorker URL>/auth/discord/callback\",\n        \"Discord側のURL設定後はWorkerの再デプロイは不要です。\"\n      ]\n    }\n  }\n}\n");

write("README.md", "# Xaccount-Bot\n\nDiscord-Bot のサーバー管理機能と Discord-Security のリアルタイム防御を、**1つのDiscord Application / 1つのBOT Token / 1つのCloudflare Worker** に統合したBOTです。\n\n## 構成\n\n- 管理サイト: React + Vite → GitHub Pages\n- Backend / Discord Interactions: Cloudflare Workers\n- Database: Cloudflare D1\n- Realtime:\n  - DiscordGateway: サーバー参加状態・入退室通知\n  - DiscordSecurityGateway: Anti-Nuke / Anti-Raid / Anti-Spam / Phishing / 権限・Webhook・Bot保護\n- Deploy: Discord-Bot-Factory の bot-factory.json\n\nSecurityは外部の別WorkerへHMAC接続する方式ではなく、同じWorker内の内部APIとして呼び出します。そのため SECURITY_API_BASE_URL と別Security BOT Tokenは不要です。\n\n## Bot Factory\n\nRepository root の bot-factory.json をFactoryが読み取り、必要なDiscord情報・Privileged Gateway Intents・権限チェックを表示します。\n\nFactoryから起動すると apps/worker が xaccount-bot としてCloudflareへデプロイされ、D1とDurable Objectsを使用します。\n\n## GitHub Pages\n\n.github/workflows/pages.yml が apps/web をGitHub Pagesへデプロイします。\n\nDashboard URL:\n\nhttps://mnaoki20081106-afk.github.io/Xaccount-Bot/\n\nRepository Variable VITE_API_BASE_URL にはFactoryでデプロイされたWorker URLを設定してください。\n\n## GitHub Pages の初回設定\n\nこのリポジトリでは管理サイトのビルド自体は成功していますが、GitHub Pages のリポジトリ設定は GitHub App から有効化できません。\n\n初回のみ次を設定してください。\n\n1. GitHub の `Xaccount-Bot` → **Settings** → **Pages**\n2. **Build and deployment** の Source を **GitHub Actions** にする\n3. Bot Factory で Worker を起動した後、`Xaccount-Bot` → **Settings** → **Secrets and variables** → **Actions** → **Variables** に `VITE_API_BASE_URL` を追加\n4. 値には Factory がデプロイした `xaccount-bot` Worker の HTTPS URL を入れる\n5. Actions の **Deploy Xaccount-Bot dashboard to GitHub Pages** を再実行する\n\n管理サイトの想定URLは `https://mnaoki20081106-afk.github.io/Xaccount-Bot/` です。\n\n## 必須Discord設定\n\n- Server Members Intent: ON\n- Message Content Intent: ON\n- BOTロール: 人間の管理者より下、操作対象ロールより上\n- サーバー管理、チャンネル管理、ロール管理、Kick/Ban、Timeout、Webhook/メッセージ管理の各権限\n\n## 安全設計\n\n- 自分自身のApplication IDはSecurityエンジンの信頼対象です。\n- 管理操作はMaintenance Leaseを通し、Security側の誤検知を抑止します。\n- 人間の上位管理者は自動Kick/BAN/Timeoutの対象にしません。\n- 高信頼度の破壊操作はLockdownで封じ込めます。\n- Securityの重要モジュールは管理画面から実質無効化できないSecurity Floorを維持します。\n\n## Source\n\n統合元:\n\n- mnaoki20081106-afk/Discord-Bot\n- mnaoki20081106-afk/Discord-Security\n\n両方の実装をそのまま再利用できる部分は維持し、Worker境界だけを同一プロセス内の内部呼び出しへ置き換えています。\n");

write("apps/worker/test/integrated-security.test.mjs", `import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("integrated security is bound locally", () => {
  const wrangler = fs.readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const bridge = fs.readFileSync(new URL("../src/security-bridge.ts", import.meta.url), "utf8");
  const index = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(wrangler, /SECURITY_GATEWAY/);
  assert.match(wrangler, /DiscordSecurityGateway/);
  assert.doesNotMatch(wrangler, /SECURITY_SERVICE/);
  assert.match(bridge, /handleIntegratedSecurityRequest/);
  assert.match(index, /runIntegratedSecurityScheduled/);
  assert.match(index, /export \\{ DiscordSecurityGateway \\}/);
});
`);

console.log("Integrated Xaccount-Bot patches applied.");
