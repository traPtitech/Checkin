# Checkin — Handover

> 引き継ぎ用。別エージェント／開発者が続きを進めるための現状・規約・残作業まとめ。
> 最終更新: 2026-06-21 / ブランチ: `claude/checkin-auth-collection`（未 push）

## 0. TL;DR

traP の Stripe 集金・払い戻しシステム「Checkin」。design.md（リポジトリ直下）が一次設計。
第一弾スコープ（①集金 ②入出金一覧 ③払い戻し）＋認証基盤＋利用者 UI＋会計 UI＋**重複支払い防止（発行台帳）**を **OpenSpec 仕様駆動**で実装済み。

- **全ゲート緑**: `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test`（120 tests）。
- **10 changes をアーカイブ済み**（`openspec/changes/archive/`）、**13 specs**（`openspec/specs/`）。
- **未コミット差分あり**（`add-accountant-ui` ＋ `add-issuance-ledger` ＋ dev 環境）。**push / PR は未実施**。
- 直近: `add-issuance-ledger`（半期スロット台帳で会員費の二重払いを拒否）。**実 Stripe で E2E 済み**（発行→支払い→再発行拒否／未払い時 URL 再利用／通期×半期の重複拒否）。Codex 2 周レビューで money-safety（draft-first 順序）を確定。
- **ローカル dev 構成あり**（下記 §10）: `.env`＋`apps/web/.env` symlink、Dev ログイン `/dev/login`、Stripe test キー＋4 Price＋`stripe listen` 配線済み。
- ローカル MariaDB 稼働中（`docker compose`、migration 0000–0006 適用済み）。

## 1. スタック / レイアウト

- pnpm workspaces モノレポ。TypeScript strict / Node 22 / ESM。
- `apps/web` — Nuxt 4（UI ＋ Nitro サーバ。oRPC をホスト）。UI は `@nuxt/ui`（Tailwind v4）。
- `packages/api` — oRPC ルータ＋ドメイン（auth / billing / stripe / jomon / payouts / payments / notify / webhook）。
- `packages/db` — Drizzle ORM + MariaDB（`mysql2`）。schema は `packages/db/src/schema.ts`、migration は `packages/db/drizzle/`（コミット対象）。
- 規約は `openspec/project.md` と各 `CLAUDE.md`/README を参照。

主要ファイル:
- oRPC: `packages/api/src/router.ts`（`appRouter`）, `packages/api/src/orpc.ts`（`Context` ＋ `pub`/`memberProc`/`userProc`/`adminProc`）。
- Nitro: `apps/web/server/routes/`（`rpc/[...].ts` マウント、`csrf`/`login`/`login/callback`/`logout`/`verify-email/confirm`/`webhook/invoice-paid`/`webhook/account-updated`）, `apps/web/server/utils/`（`auth.ts` の `buildRequestContext`、`*-config.ts`）。
- UI: `apps/web/app/`（`pages/{index,verify-email,membership}.vue`、`layouts/default.vue`、`composables/{useAuthMe,useCsrf,useSanitizeRedirect}.ts`、`plugins/orpc.ts`）。

## 2. 開発ワークフロー（これを踏襲してほしい）

仕様駆動。1 機能 = 1 capability を小さく刻む。OpenSpec CLI は `@fission-ai/openspec`（root devDependency、`node_modules/.bin/openspec`、`OPENSPEC_TELEMETRY=0` 推奨）。

各 change のループ:
1. `openspec new change "<name>"` → `proposal.md` / `specs/<cap>/spec.md`（ADDED/MODIFIED デルタ）/ `design.md` / `tasks.md` を作成（メインエージェントが仕様・設計）。
2. `openspec validate <name> --strict` で検証。
3. **実装はサブエージェントに委譲**（general-purpose）。既存実装パターンの踏襲を指示。
4. **Codex CLI でレビュー**（`codex:codex-rescue` agent。money/identity 整合を重点）。指摘は別サブエージェントで同 change 内修正。
5. delta を `openspec/specs/` に **sync**（手動編集。MODIFIED は本体 spec の該当 requirement を置換、ADDED は追記）。
6. `openspec/changes/archive/YYYY-MM-DD-<name>/` へ **archive**（`mv`）。
7. **コミット**（ユーザーが明示したときのみ。ブランチは default `main` から切る）。

完了条件: lint/typecheck/build/test 緑 ＋ 可能なら実サーバ＋MariaDB で E2E。
注: ユーザー記憶 `~/.claude/projects/-home-kaitoyama-Checkin/memory/`（`checkin-workflow.md` / `jomon-integration.md`）にも方針あり。

## 3. 実装済み（10 changes / 13 specs）

| capability (spec) | change | 要点 |
|---|---|---|
| identity | add-auth-foundation (+traq) | 本人キー=`mail_hash`（HMAC-SHA256）。`users.traq_id`(unique) で traQ 連結。メール平文は非保存（非 PII の Stripe/traQ 参照は可） |
| email-verification | add-auth-foundation | isct マジックリンク（`@m.isct.ac.jp`）。単回・期限・ハッシュ保存。Mailer アダプタ（log/SendGrid） |
| session | add-auth-foundation (+traq) | **デュアル・アイデンティティ**: `{ traqId, isAdmin, userId, mailHash }`。`__Host-` cookie＋double-submit CSRF。`requireMember/User/Admin` |
| admin-authorization | add-auth-foundation (+traq) | traQ OAuth(PKCE)=**会員セッション**。会計は env 許可リスト・サブセット（`isAdmin`） |
| stripe-customer | add-membership-collection | Customer get-or-create（DB→検索→作成、競合安全）。アダプタ境界 |
| membership-billing | add-membership-collection (+traq) | 期判定（前期4-9/後期10-3、活動年度4/1-3/31）→ price 選択。`issueInvoice`(本人=mail_hash一致) / `issueSpecialInvoice`(会計のみ ¥2,000)。支払い時に traq_id 連結 |
| payment-webhook | add-membership-collection | `invoice.paid` 署名検証＋event 冪等＋会計通知（Notifier） |
| payment-listing | add-payment-listing | 会計のみ `payments.listInvoices`/`listCheckoutSessions`（Stripe 由来、カーソル、Dashboard URL） |
| connect-onboarding | add-connect-onboarding | Connect connected account JIT onboarding。`account.updated` でフラグ判定 → `payout_onboarding_status`(none/requested/done) |
| payout-execution | add-payout-execution (+fix-jomon) | Jomon 取込→本人特定(`users.traq_id`)→onboarding ゲート→**原子的クレーム**→Stripe transfer(冪等)→結果書き戻し。`payouts` テーブル |
| member-ui | add-member-ui | `@nuxt/ui`。`/`・`/verify-email`・`/membership`(§5.1 分岐) |
| accountant-ui | add-accountant-ui | 会計 UI。`/payments`(請求書/決済セッションのタブ・status フィルタ・append ページネーション・Dashboard リンク)・`/payouts`(Jomon 取込 processApproved・status 一覧・行ごと execute／onboarding リンク発行・状態確認)。全 `adminProc`、UI ガードは UX。一覧取得は request-seq でフィルタ変更の競合防止 |
| issuance-ledger | add-issuance-ledger | **重複支払い防止**。`membership_slots` テーブル `UNIQUE(user_id, activity_year, half)`。¥4,000=通期(前期+後期2行)/¥2,000=半期1行。発行は **draft-first**(draft作成→id付きスロット予約→finalize)で「支払い可能 invoice はガード無しで残らない」不変条件。paid拒否/未払いは同一URL再利用/部分重複拒否。`invoice.paid` で paid 確定。継続は翌年度。`packages/api/src/ledger/`（coverage/store/issue） |

価格マトリクス・coverage（ユーザー確定、`add-issuance-ledger`）: **¥4,000=通期 / ¥2,000=半期1つ**。
- 入部・復旧 前期 → ¥4,000 通期（本人）／後期 → ¥2,000 後期のみ（本人）。
- 継続 標準 → ¥4,000 通期（本人、会計が後期に開始＝**翌年度**カバー）。
- 特別（会計発行・常に ¥2,000・前期/後期のみ指定）: 前期のみ特別、前期のみだった人の後期追加（ルール4）。`issueSpecialInvoice` に `coverage`(zenki/kouki)＋`activityYear`(任意) を追加。

## 4. 重要な設計判断・不変条件（壊さないこと）

- **本人キーは `mail_hash`**。traQ ID は**認証済みセッション由来のみ**連結（フォーム入力は信頼しない＝design §4.1）。Jomon payout は traQ ID で来るので `users.traq_id`→本人解決。
- **二重送金防止（payout）**: `payouts.jomon_ref` unique ＋ 冪等 upsert ＋ 原子的クレーム（`status=processing` への条件付き UPDATE、`paid`/`processing` 除外）＋ Stripe 冪等キー `payout:${jomonRef}` ＋ `paid` 早期 return。書き戻し失敗は再試行（送金は再実行しない、`jomon_written_back_at` で管理）。
- **集金の重複防止**（`add-issuance-ledger`）: `membership_slots` の `UNIQUE(user_id, activity_year, half)` が本体。**draft-first** で支払い可能 invoice はガード無しで残らない。paid 再発行は拒否・未払いは同一 URL 再利用・通期×半期の重なりは拒否。`invoice.paid` で paid 確定。Stripe 冪等キーは廃止（台帳が dedup）。
- **認可順序**: `memberProc`/`userProc`/`adminProc` は oRPC middleware で**入力検証より前**に走る（未認可で入力形状を漏らさない）。状態変更は `assertCsrf()`。
- **Stripe/Jomon 型はアダプタ層に隔離**。`billing/`・`payouts/`・`payments/` ドメインは SDK を直接呼ばない（型のみ可）。oRPC 出力はプレーン DTO。
- **メール平文を DB に保存しない**。ログイン中もセッションは `mailHash` のみ。請求時はメール再入力＋`mail_hash` 一致検証。

## 5. 残作業（優先度順）

### A. 実 Jomon 連携（要 Jomon メンテナ調整 → その後コードは概ね準備済み）
実 API 調査済み（`packages/api/src/jomon/http.ts` に実装、default driver は `stub`）。**Jomon 側に 2 つの追加が必要**:
1. **Bearer サービストークン受け口**: 現状 Jomon(v1/v2) は traQ OAuth/cookie のみで Bearer 受け口が無い。Checkin→Jomon は片方向 Bearer 前提。
2. **v2 の per-payee 書き戻し API**: v2 は `ApplicationTarget.paid_at` が読み取り専用で「支払い済み」を個別に書ける API が無い（v1 は `PUT /api/applications/{id}/states/repaid/{trapId}` あり）。design §9 / Jomon issue #183 系。
- 上記が入ったら `JOMON_API_VERSION=v1`/`v2` で実接続 E2E。`jomon/http.ts` の `// TODO: confirm field names/paths against live Jomon` を実レスポンスで確定（特に v1 の 1 application 複数 payee の amount 分配は未確定）。
- 実 API 形（確認済み）: 一覧 `GET /api/applications`（v1 `current_state=accepted`/v2 `status=approved`）。payee=traQ ID（v1 `repaid_to_user.trap_id`、v2 `target`UUID→`GET /api/users`の`name`）。通貨なし(jpy)。

### B. Stripe 実 E2E（test キー投入で可能）
- 集金: `STRIPE_SECRET_KEY`(test) ＋ `PRICE_*`(4種) ＋ `STRIPE_WEBHOOK_SECRET` → `/membership` から発行→支払い→`invoice.paid` 通知。
- 払い戻し: Connect 有効な test キー ＋ `STRIPE_CONNECT_WEBHOOK_SECRET` → onboarding リンク→`account.updated`→`done`→transfer。
- 各 change の tasks.md 最後の E2E 項目が BLOCKED で残っている（キー投入後に実施）。

### C. 会計（管理）UI（✅ 実装済み = `add-accountant-ui`）
`/payments`（入出金一覧・フィルタ・append ページネーション・Dashboard リンク）と `/payouts`（払い戻し管理: `processApproved`/`list`/`execute`/`createOnboardingLink`/`onboardingStatus`）を実装済み。残りの会計 UI:
- **`/admins`**: 会計は env 許可リスト管理（旧 DB 管理者テーブルは deprecated）なので管理 UI は**意図的に未実装**。traQ グループ判定（後述 D）に移行する場合も UI は不要の見込み。
- **特別請求書発行 UI**（`membership.issueSpecialInvoice`、会計のみ ¥2,000）: 対象 user を選ぶ検索/一覧 API・UI が無く未実装。先に user 検索 API（または payouts 一覧の userId から発行）を足す小さな change が必要。

### D. ハードニング・フォローアップ
- `users.stripe_customer_id` に connected account 同様の **unique 制約＋get-or-create 競合対策**（Codex 指摘の後続）。小さな change。
- ~~集金の永続的発行台帳~~ → **完了**（`add-issuance-ledger`、半期スロット台帳）。
- traQ グループによる会計判定（現状は env 許可リスト `CHECKIN_ACCOUNTANT_TRAQ_IDS`）。
- ロゴ画像（現状テキスト）、`/payouts/onboarding/{refresh,return}` の戻り先ページ（Account Link 用、現状未作成）。

## 6. 環境変数（`.env.example` 参照）

必須(実運用): `DATABASE_URL`, `MAIL_HASH_SECRET`(不変運用), `APP_ORIGIN`, `CHECKIN_ACCOUNTANT_TRAQ_IDS`, `TRAQ_OAUTH_*`(登録済みクライアント), `MAILER_DRIVER`(+SendGrid), `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`PRICE_*`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `JOMON_API_BASE_URL`/`JOMON_API_TOKEN`/`JOMON_API_VERSION`(default stub)。
runtime override は Nuxt の `NUXT_` 接頭辞（例 `NUXT_DATABASE_URL`、`NUXT_MAIL_HASH_SECRET`）。

## 7. ローカル実行・検証

```bash
pnpm install
docker compose up -d                 # MariaDB（既に起動済み）
DATABASE_URL="mysql://checkin:password@localhost:3306/checkin" pnpm db:migrate
pnpm dev                             # 開発（http://localhost:3000）
# or 本番相当:
pnpm build
NUXT_DATABASE_URL="mysql://checkin:password@localhost:3306/checkin" \
  NUXT_MAIL_HASH_SECRET="x" NUXT_APP_ORIGIN="http://localhost:3000" \
  PORT=3000 node apps/web/.output/server/index.mjs
pnpm test                           # vitest（DB バックドテストは MariaDB 必要、無ければ self-skip）
```
スモーク: `GET /csrf`→token、`POST /rpc/auth/requestEmailVerification`(CSRF ヘッダ要)→LogMailer がリンク出力→そのリンク GET でセッション確立→`POST /rpc/auth/me`。

## 8. 落とし穴

- **drizzle-kit generate は対話を要求することがある**（列の rename 誤検出など）。非 TTY では失敗するので、列追加/変更は新規として進める。**baseline migration（0000 以降）は保持**（過去に scaffold の 0000 をリセットした経緯あり）。
- **`__Host-` cookie は Secure 必須**。localhost(http) でも主要ブラウザは localhost を secure 扱いで動く。
- **SSR の auth.me**: `plugins/orpc.ts` が SSR 時に cookie を転送し、クライアントは mutation に `x-csrf-token` を自動付与（CSRF cookie 由来）。
- **oRPC 入力検証は middleware の後**（`memberProc` 等で認可が先）。cookie を扱う `/csrf`・`/login`・`/logout`・`/verify-email/confirm`・webhook は **Nitro ルート**（oRPC ではない）。
- **コミットは `git add -A` で UI 等の未コミット差分も巻き込む**ので、change 境界に注意。
- **@nuxt/ui `USelect` の選択肢に空文字 `value:''` は不可**（''は「選択クリア／placeholder」予約。ハイドレーション時に throw → ページが 500）。「すべて」等は `'all'` 等のセンチネル値にし、API へ渡す時に `=== 'all' ? undefined : v` で変換する。**lint/typecheck/build/Codex は検出できず、実ブラウザ（Playwright）でのみ顕在化**した（`add-accountant-ui` で発生・修正済み）。UI は実描画で確認すること。
- **会計 UI のローカル検証**: traQ OAuth 無しで会計セッションを偽造できる — `sessions` に `is_admin=1` 行を挿入（`id_hash = sha256hex(token)`）し、ブラウザに `__Host-checkin_session=<token>` を渡す。headless+http では Secure な CSRF cookie が保持されず mutation が 403 になるので、mutation は curl（`/csrf`→cookie＋`x-csrf-token` ヘッダ）で確認する。

- **発行は draft-first**（`packages/api/src/ledger/issue.ts` の `issueWithLedger`）: draft 作成→id 付きスロット予約→finalize。**ledger-first（予約→発行→id 書き戻し）にしてはいけない**（支払い可能 invoice がガード無しで残る窓ができる＝Codex HIGH）。`finalizeAndSendInvoice` は「draft のときだけ throw」不変条件・email は best-effort・`createDraftInvoice` は**非冪等**（同時発行が別 id を引くため。同一冪等キーだと敗者が勝者の invoice を void）。
- **Stripe 冪等キーのテスト汚染**: 同じ customer/price/year/feeType で過去に作った invoice が Stripe 側の冪等ウィンドウ（〜24h）に残ると、台帳を消しても再発行が「finalize 済み invoice を再 finalize」で 500。E2E は `/dev/login?as=user&email=<fresh>` で毎回新規 customer を使う。

## 9. 次の一手（推奨）

1. （並行）Jomon メンテナと Bearer 受け口＋v2 書き戻しを握る（残作業 A）。
2. Stripe/Connect の test キーが入ったら各 BLOCKED E2E を消化（残作業 B）。会計 UI（`/payments`・`/payouts`）も実データで E2E（`add-accountant-ui` の tasks 4.3/4.4）。
3. `stripe_customer_id` unique 化（残作業 D）。
4. （任意）特別請求書発行 UI（会計が `coverage`/`activityYear` 指定）＋ user 検索 API（残作業 C の残り）。
5. （任意）銀行振込（`customer_balance`/`jp_bank_transfer`、請求書ごとに付与）＝別 change。

## 10. ローカル dev 環境（このセッションで構築・未コミット）

- **`.env`**（root）＋ **`apps/web/.env` → `../../.env` symlink**（`nuxt dev` は rootDir=`apps/web` から `.env` を読むため必須。無いと `DATABASE_URL is not set`）。`MAIL_HASH_SECRET` 生成済み、`CHECKIN_DEV_LOGIN="1"`。
- **Dev ログイン** `GET /dev/login`（`apps/web/server/routes/dev/login.get.ts`）: `?as=admin|member|user|both`、`?email=`（user/both、既定 `dev-user@m.isct.ac.jp`）、`?redirect=`。**二重ガード**（`import.meta.dev` ＝本番ビルドで false に焼かれ 404 ＋ `CHECKIN_DEV_LOGIN=1`）で本番無効を実ビルドで検証済み。traQ OAuth 無しで会計/会員/利用者セッションを発行。
- **Stripe**: test secret key 投入済み、**4 Price 作成・配線済み**（`PRICE_*`）。`stripe listen --forward-to localhost:3000/webhook/invoice-paid --forward-connect-to localhost:3000/webhook/account-updated`（`--api-key` は .env の鍵。保存鍵は期限切れだったので。両 webhook secret に共通 `whsec_`）。`/tmp/stripe-listen.pid`、`/tmp/checkin-dev.pid`、ログ `/tmp/checkin-dev.log`。
- 起動: `pnpm dev`（:3000）。MariaDB は docker で稼働・migration 0007 まで適用済み。
