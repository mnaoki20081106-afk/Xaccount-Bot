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

write("apps/worker/src/security-bridge.ts", `import type { Env } from "./types";
import { handleIntegratedSecurityRequest } from "./security/service";

export function securityBridgeConfigured(env: Env): boolean {
  return Boolean(
    env.SECURITY_GATEWAY &&
    env.DISCORD_BOT_TOKEN?.trim() &&
    env.DISCORD_APPLICATION_ID?.trim()
  );
}

export async function securityBridgeFetch(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!securityBridgeConfigured(env)) {
    throw new Error("Integrated Security is not configured");
  }

  const url = new URL(
    path.replace(/^\\//, ""),
    "https://integrated-security.internal/"
  );

  const method = String(init.method ?? "GET").toUpperCase();
  const request = new Request(url.toString(), {
    ...init,
    method,
    body: method === "GET" || method === "HEAD" ? undefined : init.body,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  return handleIntegratedSecurityRequest(request, env);
}

export async function securityBridgeJson<T>(
  env: Env,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await securityBridgeFetch(env, path, init);
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text) as { message?: string; error?: string };
      message = parsed.message ?? parsed.error ?? text;
    } catch {
      // keep raw text
    }
    throw new Error(
      "Integrated Security API " + response.status + ": " + message.slice(0, 300)
    );
  }
  return text ? JSON.parse(text) as T : undefined as T;
}

export async function openSecurityMaintenanceLease(
  env: Env,
  guildId: string,
  scope: "dashboard_edit" | "restore",
  seconds: number
): Promise<{ id: string; expiresAt: number } | null> {
  if (!securityBridgeConfigured(env)) return null;
  return securityBridgeJson(env, "/internal/guilds/" + guildId + "/maintenance", {
    method: "POST",
    body: JSON.stringify({
      actorId: env.DISCORD_APPLICATION_ID,
      scope,
      seconds
    })
  });
}
`);

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
  '      const url=new URL(request.url);\n      ctx.waitUntil(ensureDiscordSecurityGateway(env).catch(error=>console.error("integrated security gateway start failed",error)));\n\n      if(request.method==="OPTIONS"){',
  "main fetch security startup"
);
mainIndex = replaceRequired(
  mainIndex,
  '      ensureDiscordGateway(env),\n      botAccessGuardSweep(env),',
  '      ensureDiscordGateway(env),\n      runIntegratedSecurityScheduled(env),\n      botAccessGuardSweep(env),',
  "main scheduled security"
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
      "binding": "DB"
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

let pages = read(".github/workflows/pages.yml");
pages = pages.replace(
  "VITE_API_BASE_URL: https://discord-bot.c53gftun651-tiktok.workers.dev",
  "VITE_API_BASE_URL: ${{ vars.VITE_API_BASE_URL }}"
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

write("bot-factory.json", JSON.stringify({
  name: "xaccount-bot",
  runtime: "worker",
  provider: "cloudflare",
  working_directory: "apps/worker",
  wrangler_config: "wrangler.jsonc",
  d1_migrations: ["DB"],
  setup: {
    title: "Xaccount-Bot",
    description: "Discordサーバー管理とSecurityを1つのBOTとして起動します。",
    fields: [
      {
        key: "DISCORD_BOT_TOKEN",
        label: "Discord BOT Token",
        type: "secret",
        required: true,
        help: "Discord Developer Portal > Bot から取得します。"
      },
      {
        key: "DISCORD_APPLICATION_ID",
        label: "Application ID",
        type: "text",
        required: true,
        pattern: "^\\\\d{17,20}$"
      },
      {
        key: "DISCORD_PUBLIC_KEY",
        label: "Public Key",
        type: "text",
        required: true
      },
      {
        key: "DISCORD_CLIENT_SECRET",
        label: "Client Secret",
        type: "secret",
        required: true
      },
      {
        key: "SESSION_ENCRYPTION_KEY",
        label: "Session Encryption Key",
        type: "secret",
        required: true,
        pattern: "^.{32,}$",
        help: "32文字以上のランダム値を使用します。"
      },
      {
        key: "DASHBOARD_PASSWORD",
        label: "管理サイト Password",
        type: "secret",
        required: true,
        pattern: "^.{12,}$",
        help: "GitHub Pages管理画面へのログインに使用します。"
      },
      {
        key: "SHIIRE_BRIDGE_SECRET",
        label: "仕入れBOT連携 Secret",
        type: "secret",
        required: false,
        pattern: "^.{32,}$",
        help: "Discord-Shiireと連携する場合のみ。同じ32文字以上の値を設定します。"
      }
    ],
    discord: {
      intents: [
        {
          id: "server-members-intent",
          label: "Server Members Intent",
          required: true,
          description: "入退室検知・Anti-Raid・メンバー保護に必要です。",
          path: "Discord Developer Portal > Bot > Privileged Gateway Intents"
        },
        {
          id: "message-content-intent",
          label: "Message Content Intent",
          required: true,
          description: "Anti-Spam・Phishing・危険リンク判定に必要です。",
          path: "Discord Developer Portal > Bot > Privileged Gateway Intents"
        }
      ],
      permissions: [
        {
          id: "manage-guild",
          label: "サーバーの管理",
          required: true,
          description: "サーバー設定・監査・保護機能に使用します。"
        },
        {
          id: "manage-channels",
          label: "チャンネルの管理",
          required: true,
          description: "サーバー編集・復元・Lockdownに必要です。"
        },
        {
          id: "manage-roles",
          label: "ロールの管理",
          required: true,
          description: "認証ロール付与と危険ロール解除に必要です。"
        },
        {
          id: "kick-ban",
          label: "メンバーをキック / BAN",
          required: true,
          description: "高信頼度の悪性BOTや攻撃への対処に必要です。"
        },
        {
          id: "moderate-members",
          label: "メンバーをタイムアウト",
          required: true,
          description: "スパム・荒らしへの可逆的な制裁に必要です。"
        },
        {
          id: "manage-messages-webhooks",
          label: "メッセージ / Webhookの管理",
          required: true,
          description: "危険メッセージ削除とWebhook保護に必要です。"
        }
      ],
      checks: [
        {
          id: "role-order-human-admin",
          label: "人間の管理者ロールをXaccount-Botより上に配置",
          required: true,
          description: "人間の管理者を自動制裁対象にしないロール階層を維持します。"
        },
        {
          id: "role-order-bot",
          label: "Xaccount-Botを操作対象ロールより上に配置",
          required: true,
          description: "Discordのロール階層制限により必要です。"
        }
      ],
      notes: [
        "1つのDiscord Application / 1つのBOT Tokenで管理機能とSecurity機能を動かします。",
        "Security用に別BOTを追加する必要はありません。"
      ]
    }
  }
}, null, 2) + "\n");

write("README.md", `# Xaccount-Bot

Discord-Bot のサーバー管理機能と Discord-Security のリアルタイム防御を、**1つのDiscord Application / 1つのBOT Token / 1つのCloudflare Worker** に統合したBOTです。

## 構成

- 管理サイト: React + Vite → GitHub Pages
- Backend / Discord Interactions: Cloudflare Workers
- Database: Cloudflare D1
- Realtime:
  - DiscordGateway: サーバー参加状態・入退室通知
  - DiscordSecurityGateway: Anti-Nuke / Anti-Raid / Anti-Spam / Phishing / 権限・Webhook・Bot保護
- Deploy: Discord-Bot-Factory の bot-factory.json

Securityは外部の別WorkerへHMAC接続する方式ではなく、同じWorker内の内部APIとして呼び出します。そのため SECURITY_API_BASE_URL と別Security BOT Tokenは不要です。

## Bot Factory

Repository root の bot-factory.json をFactoryが読み取り、必要なDiscord情報・Privileged Gateway Intents・権限チェックを表示します。

Factoryから起動すると apps/worker が xaccount-bot としてCloudflareへデプロイされ、D1とDurable Objectsを使用します。

## GitHub Pages

.github/workflows/pages.yml が apps/web をGitHub Pagesへデプロイします。

Dashboard URL:

https://mnaoki20081106-afk.github.io/Xaccount-Bot/

Repository Variable VITE_API_BASE_URL にはFactoryでデプロイされたWorker URLを設定してください。

## 必須Discord設定

- Server Members Intent: ON
- Message Content Intent: ON
- BOTロール: 人間の管理者より下、操作対象ロールより上
- サーバー管理、チャンネル管理、ロール管理、Kick/Ban、Timeout、Webhook/メッセージ管理の各権限

## 安全設計

- 自分自身のApplication IDはSecurityエンジンの信頼対象です。
- 管理操作はMaintenance Leaseを通し、Security側の誤検知を抑止します。
- 人間の上位管理者は自動Kick/BAN/Timeoutの対象にしません。
- 高信頼度の破壊操作はLockdownで封じ込めます。
- Securityの重要モジュールは管理画面から実質無効化できないSecurity Floorを維持します。

## Source

統合元:

- mnaoki20081106-afk/Discord-Bot
- mnaoki20081106-afk/Discord-Security

両方の実装をそのまま再利用できる部分は維持し、Worker境界だけを同一プロセス内の内部呼び出しへ置き換えています。
`);

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
