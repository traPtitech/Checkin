## 1. 共通基盤（整形・導線・ガード）

- [x] 1.1 整形 util（金額 `formatAmount(amount, currency)`＝`Intl.NumberFormat`、日時 `formatDateTime(iso)`＝`Intl.DateTimeFormat`）を `app/utils` か composable に追加
- [x] 1.2 `app/layouts/default.vue` ヘッダーに会計導線（`/payments`・`/payouts`）を `admin` のときのみ表示
- [x] 1.3 `app/pages/index.vue` に会計導線（`admin` のときのみ）を追加
- [x] 1.4 会計ガード（非 `admin` は本体非表示＋要会計ログイン案内＋会計ログイン導線）の共通方針を `/payments`・`/payouts` 両方で適用

## 2. `/payments`（入出金一覧）

- [x] 2.1 `app/pages/payments.vue`: タブ（請求書/決済セッション）。`admin` ガード
- [x] 2.2 請求書タブ: `payments.listInvoices({ status?, startingAfter? })` を呼び、行（id・金額・通貨・日時・customer・支払い状況・支払い id・商品）を表で表示。Dashboard リンク（`dashboardUrl`、`target="_blank"`）
- [x] 2.3 決済セッションタブ: `payments.listCheckoutSessions(...)` を同様に表示
- [x] 2.4 status フィルタ（請求書: draft/open/paid/uncollectible/void、決済: open/complete/expired）。変更時はリスト＋カーソルをリセットして再取得
- [x] 2.5 append 型ページネーション: `hasMore` が真のときだけ「もっと読む」、`nextCursor`→`startingAfter` で追記取得

## 3. `/payouts`（払い戻し管理）

- [x] 3.1 `app/pages/payouts.vue`: 一覧（`payouts.list({ status? })`、行: jomonRef・userId・金額・通貨・status・transfer id・Jomon 書き戻し済みか）。`admin` ガード
- [x] 3.2 status フィルタ（pending/onboarding_waiting/processing/paid/failed）。変更で再取得
- [x] 3.3 Jomon 取込ボタン: `payouts.processApproved()` → 件数サマリ表示 → 一覧再取得。実行中 disabled
- [x] 3.4 行 execute: `paid` 以外に `payouts.execute({ jomonRef })` → 結果表示 → 再取得。行ごと pending で二重操作防止
- [x] 3.5 onboarding リンク発行: userId のある行に `payouts.createOnboardingLink({ userId })` → 返った URL を会計に表示（コピー可、自動送信しない）
- [x] 3.6 onboarding 状態確認: userId のある行に `payouts.onboardingStatus({ userId })` → status＋connected account の有無を表示

## 4. 検証

- [x] 4.1 `pnpm lint` / `pnpm typecheck` / `pnpm build` をグリーンにする
- [x] 4.2 ローカル起動＋Playwright で確認: 非会計（未ログイン）で `/payments`・`/payouts` がアクセス不可表示（「会計ログインが必要です」）＋トップに会計導線が出ないこと。**会計セッションを偽造（`sessions` に `is_admin=1` 行を挿入し `__Host-checkin_session` cookie を注入）＋サンプル payouts を seed** して会計パスも検証: 両ページ描画、`/payments` のタブ・status フィルタ・通貨列・Stripe 鍵無し時の一覧エラー表示、`/payouts` の 4 行表示・status バッジ・条件付き操作ボタン（`paid` は実行ボタン無し／`failed` は「再試行」／userId 無し行は onboarding ボタン無し）・status フィルタ・onboarding 状態のインライン表示。CSRF mutation（processApproved/execute/createOnboardingLink）は headless+http で Secure CSRF cookie が保持されず 403 になるが、curl で cookie＋`x-csrf-token` を付ければ 200（`processApproved`→`ingested:0` の stub サマリ、`onboardingStatus`→seed 値）を確認＝実装は正。**Playwright が実バグを 1 件検出・修正**: `USelect` の「すべて」選択肢に空文字 `value:''` を使っており @nuxt/ui がハイドレーション時に throw → 両ページが 500。`ALL='all'` センチネル（API へは `undefined`）に変更して解消（lint/typecheck/build/test 緑）
- [ ] 4.3 （Stripe test キー投入後）`/payments` で実 Invoice/Checkout の一覧・フィルタ・Dashboard リンク・ページネーションを確認
  - BLOCKED: Stripe test キー未投入。鍵なしでは一覧は空またはエラー。`NUXT_STRIPE_SECRET_KEY` 投入後に実データで確認
- [ ] 4.4 （Jomon 接続投入後）`/payouts` で取込→一覧→execute→onboarding の E2E を確認
  - BLOCKED: Jomon 実接続（Bearer 受け口）未確定。default driver は stub。接続投入後に実データで確認
