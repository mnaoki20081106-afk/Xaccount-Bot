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

Pages workflowは`VITE_API_BASE_URL`未設定時にビルドを失敗させます。推測したworkers.dev URLへ自動フォールバックしません。

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
XACCOUNT_BOT_BASE_URL
```

`XACCOUNT_BOT_BASE_URL` には、実際にデプロイされた Xaccount-Bot Worker の HTTPS origin を設定します。これは仕入れbot自販機のPayPay/Kyash決済委譲に必要です。

`SHIIRE_BRIDGE_SECRET` は両方に同じ強いランダム値を設定してください。

`SHIIRE_API_BASE_URL` は、実際にデプロイされた Discord-Shiire Worker の HTTPS origin を設定します。

例のホスト名を推測して設定しないでください。未設定時、管理画面は `SHIIRE_API_BASE_URL_NOT_CONFIGURED` を返して停止します。

### 仕入れbotタブから管理できるもの

Discord-Shiireの日常運用は、原則としてXAccount-Botのメイン管理サイトだけで完結します。

- Discord-Shiire Botの導入状態 / API接続状態
- HStora / Binance / LTC / 資金状態
- LTC補充モード
- 仕入れ資金配分（招待用 / No shadow ban / Top Search）
- 資金割合変更時のHStora現在残高への再配分
- PayPay残高 / USD・JPY観測
- 資金上限・LTC目標・各種急変停止設定
- Dry Run / 自動購入 / 自動仕入れ / Emergency Stop
- Circuit Breaker解除 / 大量購入一時承認
- HStora仕入れ条件・価格上限・試験購入・品質ガード
- 承認済みHStora商品ID / Seller品質モード
- 毎日18:00のNo shadow ban / Top Search恒常在庫
- 18:00入荷のON/OFF / 今すぐ差分入荷
- 在庫入荷通知の文言 / 通知チャンネル / 通知パネル設置・更新
- 招待キャンペーンON/OFF
- 何人招待ごとに1垢 / 招待用恒常在庫
- 招待状態再同期 / 報酬配布再試行
- 在庫 / HStora商品キャッシュ / 仕入れ注文 / 監査ログ
- Shiire自販機の作成
- HStora仕入れ商品または在庫クラスと販売商品の紐付け
- PayPay/Kyash販売価格
- 商品名 / 説明 / 絵文字
- 商品編集
- 自販機パネルタイトル / 説明
- パネル画像アップロード
- Discordパネル設置 / 更新
- 購入後ロール
- 公開 / 非公開購入ログ
- 自販機単位の在庫入荷通知設定
- クーポン
- 販売注文履歴

API Secret・暗号化キー・HMAC Secretなどの秘密情報と、注文照合用の内部スナップショットは管理画面から直接編集できません。これらはWorker Secretまたは専用の安全な操作経路で管理します。

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

No Shadowban と TOP Search の両方を明示する高品質商品は、現行の仕入れポリシーでは偶数個で購入して `TOP_SEARCH` / `NO_SHADOWBAN` へ50:50で配分します。HStora商品 4521 は品質方針上の例外として `NO_SHADOWBAN` のみに分類します。

仕入れbotタブの「仕入れ」から、各クラスの価格上限・発注点・旧target_stock・初回試験購入数・1回最大仕入れ数・品質ガード・大量購入ガードを変更できます。通常販売在庫の実際の恒常在庫数は「18:00入荷」で別途設定します。Dry Run、自動購入、自動仕入れも「資金・LTC」から操作できます。

販売商品は個別HStora商品IDではなく在庫クラスへ紐付けることを推奨します。これにより、最安の仕入先が商品Aから商品Bへ変わっても、同じDiscord自販機商品へ自動的に在庫が追加されます。


### 仕入れbotの資金・安全設定

Discord-ShiireとのBridge設定後は、Main管理画面の「仕入れbot」タブから資金上限・仕入れ割合・PayPay残高観測・USD/JPY観測・Dry Run・自動購入・自動仕入れ・Emergency Stop・Circuit Breaker解除・大量購入一時承認まで操作できます。

HStoraへの入金増加は1分Cronで検知して設定済みの仕入れ割合へ配分します。No shadow ban / Top Searchの通常販売在庫は毎日18:00に恒常在庫との差分だけを仕入れ、招待キャンペーン在庫は報酬切れを避けるため随時補充します。18:00の顧客向け在庫通知は、実際に在庫追加が1個以上あった日だけ送信します。

LIVEへ切り替える操作と、LIVE中に自動購入/自動仕入れをONにする操作は確認ダイアログを要求します。Emergency Stopを解除しても自動購入・自動仕入れは自動では再開しません。


### 仕入れbot: PayPay直接LTC購入の確認

Discord-ShiireがPayPay手動操作待ち中にBinance LTC総残高の増加を検知した場合、Main BOT管理画面の「資金・LTC」に確認ボタンを表示します。

直接LTC購入は残高増加だけでは自動確定しません。「このLTC購入を確認して再開」を押すと、Discord-ShiireがBinance残高を再取得して増加を再確認した上で、PayPay支出を確定し処理を再開します。

JPY即時入金は、期待純増額を満たすJPY残高増加を確認できるため自動再開します。


## X-Utility

管理画面の **X Utility** タブから、別BOTである X-Utility の次の2パネルだけを設置できます。

- シャドウバンチェック
- 2FAコード生成

X-Utilityは先に Discord-Bot-Factory から起動し、Discordサーバーへ追加してください。

Xaccount-Bot側:

```text
XUTILITY_API_BASE_URL=https://<実際のX-Utility Worker URL>
XUTILITY_BRIDGE_SECRET=<X-Utility側と同じ32文字以上の値>
```

X-Utility側:

```text
XUTILITY_BRIDGE_SECRET=<Xaccount-Bot側と同じ値>
```

パネル投稿自体はXaccount-BotではなくX-Utility BOTが行います。Xaccount-BotはHMAC-SHA256署名付き内部APIで設置先だけを指示します。

2FAのBase32シークレットはXaccount-Botへ送信されず、X-Utilityでも保存されません。Discordモーダルで受け取ったそのリクエスト内だけでTOTPを生成し、本人限定のEphemeralメッセージで返します。
