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

## GitHub Pages の初回設定

このリポジトリでは管理サイトのビルド自体は成功していますが、GitHub Pages のリポジトリ設定は GitHub App から有効化できません。

初回のみ次を設定してください。

1. GitHub の `Xaccount-Bot` → **Settings** → **Pages**
2. **Build and deployment** の Source を **GitHub Actions** にする
3. Bot Factory で Worker を起動した後、`Xaccount-Bot` → **Settings** → **Secrets and variables** → **Actions** → **Variables** に `VITE_API_BASE_URL` を追加
4. 値には Factory がデプロイした `xaccount-bot` Worker の HTTPS URL を入れる
5. Actions の **Deploy Xaccount-Bot dashboard to GitHub Pages** を再実行する

管理サイトの想定URLは `https://mnaoki20081106-afk.github.io/Xaccount-Bot/` です。

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


## 仕入れbot 自販機

メイン管理画面には、既存の **自販機** とは完全に分離した **仕入れbot** タブがあります。

このタブは Discord-Shiire のXアカウント自動仕入れ在庫を直接販売するための管理画面です。Xアカウント認証情報そのものは Xaccount-Bot へコピーしません。

役割分担:

```text
Xaccount-Bot
  ├─ 管理画面セッション
  ├─ 仕入れbotタブ
  ├─ 既存PayPay/Kyash受取設定
  └─ HMAC bridge
            |
            v
Discord-Shiire
  ├─ HStora自動仕入れ
  ├─ AES-GCM暗号化在庫
  ├─ 自販機 / パネル
  ├─ 在庫入荷通知
  ├─ 注文予約
  └─ 購入者DM納品
```

決済資格情報を2つのWorkerへ複製しないため、Discord-Shiire は署名付き内部APIでXaccount-Botの既存PayPay/Kyash受取処理を利用します。

### 必須接続設定

Xaccount-Bot Worker:

```text
SHIIRE_BRIDGE_SECRET
SHIIRE_API_BASE_URL
```

Discord-Shiire Worker:

```text
SHIIRE_BRIDGE_SECRET
```

`SHIIRE_BRIDGE_SECRET` は両方に同じ強いランダム値を設定してください。

`SHIIRE_API_BASE_URL` は、実際にデプロイされた Discord-Shiire Worker の HTTPS origin を設定します。

例のホスト名を推測して設定しないでください。未設定時、管理画面は `SHIIRE_API_BASE_URL_NOT_CONFIGURED` を返して停止します。

### 仕入れbotタブから管理できるもの

- Discord-Shiire Botの導入状態
- 既存PayPay/Kyash受取設定の利用可否
- Shiire自販機の作成
- HStora仕入れ商品と販売商品の紐付け
- PayPay/Kyash販売価格
- 商品名 / 説明 / 絵文字
- 商品編集
- 自販機パネルタイトル / 説明
- パネル画像アップロード
- Discordパネル設置 / 更新
- 購入後ロール
- 公開 / 非公開購入ログ
- 在庫入荷通知 ON/OFF
- 入荷通知チャンネル / メンションロール
- クーポン
- 注文履歴

### Bridge安全設計

- HMAC-SHA256
- timestamp制限
- one-time nonce
- replay拒否
- 決済idempotency key
- 使用済み送金リンク重複拒否
- 新規入力された「既に完了済み」のPayPayリンクは新規決済として扱わない
- Discord-ShiireからXaccount-BotへXアカウント認証情報は送信しない

既存の **自販機** 機能は変更せず、そのまま利用できます。


### 仕入れ在庫クラス

仕入れbot自販機では、HStoraの商品IDが変わっても同じ種類として販売できる在庫クラスを選択できます。

```text
TOP_SEARCH
  - X/Twitter商品
  - TOP Search / TOP+Latest の明記必須
  - 初期上限 80円 / 1垢

NO_SHADOWBAN
  - X/Twitter商品
  - TOP Search / TOP+Latest の記載なし
  - No Shadowban / No Shadow Ban の明記必須
  - 上限 0.50〜0.60 USD / 1垢
```

両方の文言がある商品は `TOP_SEARCH` として扱い、`NO_SHADOWBAN` へ二重計上しません。

仕入れbotタブの「自動仕入れ条件」から、各クラスの価格上限・発注点・目標在庫・初回試験購入数・1回最大仕入れ数を変更できます。Dry Run解除と自動仕入れON/OFFはこの画面からは変更できません。

販売商品は個別HStora商品IDではなく在庫クラスへ紐付けることを推奨します。これにより、最安の仕入先が商品Aから商品Bへ変わっても、同じDiscord自販機商品へ自動的に在庫が追加されます。
