## Why

第一弾スコープ③「払い戻し」の前半。払い戻し（transfer/payout）には受取人の本人確認＋口座登録（Stripe Connect の connected account onboarding）が必須。これを Jomon 非依存に先行整備する。[[add-auth-foundation]] の本人識別・会計認可、[[add-membership-collection]] の Stripe アダプタ／`stripe_events` 冪等基盤の上に乗る。Jomon 連携・実送金は後続 [[jomon-integration]]（add-payout-execution）で行う。

## What Changes

- **connected account の JIT onboarding**: 受取人（`users` 行）に対し Stripe Connect の connected account を get-or-create し、Stripe **ホスト型 onboarding リンク**（Account Link）を発行する。発行で状態を `requested` にする。
- **onboarding 状態機械**: `users.payout_onboarding_status` を `none` → `requested` → `done` で管理。
  - **BREAKING（identity 拡張）**: `users` に `stripe_connected_account_id`（nullable）と `payout_onboarding_status`（既定 `none`）を追加（メール平文は引き続き保存しない。非 PII の Stripe 参照は既存方針で許容）。
- **`account.updated` Webhook**: Stripe は「完了」単発イベントを送らないため、`account.updated` を受信→署名検証→event id で冪等→対象 connected account を特定→`payouts_enabled` ＋ 未提出要件（`requirements.currently_due`）の有無で「払い出し可能か」を判定→可なら `requested` を `done` に遷移。「来たら done」ではなく**フラグで判定**する。
- **発行 API（会計のみ）**: `payouts.createOnboardingLink({ userId })`（会計が対象者の onboarding リンクを発行・取得して受取人へ案内）、`payouts.onboardingStatus({ userId })`（状態確認）。

明確に**スコープ外**（後続 add-payout-execution）: Jomon 取込・振込依頼・結果書き戻し、実際の transfer/payout 実行、Payouts テーブル、催促/再送、資金繰り。`/payouts` UI ページ。

## Capabilities

### New Capabilities
- `connect-onboarding`: Stripe Connect connected account の JIT onboarding。account の get-or-create、ホスト型 onboarding リンク発行、`account.updated` Webhook によるフラグ判定（`payouts_enabled` ＋ 要件）と冪等な状態遷移（`none`/`requested`/`done`）、会計のみの発行・状態確認 API。

### Modified Capabilities
- `identity`: `users` に `stripe_connected_account_id`（nullable）と `payout_onboarding_status`（`none`/`requested`/`done`）を追加（既存「メール平文を永続化しない」要件の非 PII 参照許容に整合）。

## Impact

- **DB（`packages/db`）**: `users` に `stripe_connected_account_id`・`payout_onboarding_status` を追加。Webhook 冪等は既存 `stripe_events` を再利用。マイグレーション生成・コミット。
- **API（`packages/api`）**: Stripe アダプタに Connect（account get-or-create / Account Link / 払い出し可否判定）を追加。onboarding 状態遷移の純粋ヘルパ。oRPC `payouts.createOnboardingLink` / `payouts.onboardingStatus`（`adminProc`）。`BillingConfig` に Connect 用 Webhook 署名シークレットを追加。
- **Web/Nitro（`apps/web`）**: `POST /webhook/account-updated`（raw body ＋ Connect 署名検証の Nitro ルート）。Account Link の refresh/return URL は `APP_ORIGIN` 配下（UI ページは後続）。
- **設定**: `STRIPE_CONNECT_WEBHOOK_SECRET`（Connect イベント用。主 Webhook と別エンドポイントの場合に備える）を env / runtimeConfig に追加。Connect の account type は Express。
- **テスト/検証**: 払い出し可否判定・状態遷移・get-or-create はユニットテスト（Stripe モック）。実 onboarding は Connect 有効な test mode で後日 E2E。
