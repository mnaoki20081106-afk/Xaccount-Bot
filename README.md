# Xaccount-Bot

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
