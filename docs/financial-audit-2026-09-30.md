# Financial integrity audit — 2026-09-30

## Fixed
- Expiration and inventory release now commit atomically, with payment state checked inside the transaction.
- Supply receipt, stock and duplicate fingerprints are written in one D1 transaction. Failed receipts no longer leave partially delivered stock; duplicate requests return the original count.
- New receipt hashes encode item boundaries unambiguously; old receipt hashes remain readable.
- PayPay and Kyash recheck the required amount immediately before acceptance.
- A consumed public PayPay link is not evidence that the seller received payment. Only a successful authenticated acceptance authorizes delivery.
- Payment receipt processing is conditionally claimed, preventing concurrent acceptance attempts. Ambiguous prior attempts remain pending; known login-required failures can retry.
- Kyash server errors or malformed acceptance responses retain the order instead of releasing it.

## Validation
Full workspace build and Worker bundle dry-run passed. All 61 Worker tests passed, including 8 new runtime/D1 regression tests. Five initial regression cases failed against the original HEAD and passed after changes. No live payment, purchase, inventory migration or deployment was performed.

## Operational limits
Orders whose acceptance response was lost require recipient-side confirmation before fulfillment. This change deliberately does not infer payment from a public consumed-link status. No new administrative reconciliation UI is included. Historical stock/receipt inconsistencies are not automatically repaired. External PayPay/Kyash endpoints were mocked; their current production behavior is unverified.

Transaction reference: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch

## Follow-up review

Reproduced a Kyash receipt retry returning provider status `COMPLETED` instead of bridge status `completed`. This blocked Discord-Shiire's completion validation after response loss. Replayed successful receipts now preserve the bridge response contract without another receive request. Missing payment-account configuration also leaves a retryable rejected receipt instead of an ambiguous in-flight receipt.

Validation: Worker typecheck, bundle dry-run and all 62 Worker tests passed (9 financial regression cases). No live payments or deployment were performed.

## 2026-10-01 main統合検証

最新main（4ec5454）の管理画面と価格更新時パネル再設置、検索認証情報管理を統合。全workspaceビルド・Worker 62テスト・Web 13テスト成功。
実送金・本番デプロイの検証は実施していない。
