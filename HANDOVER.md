# Checkin — Handover

> 引き継ぎ用。別エージェント／開発者が続きを進めるための現状・規約・残作業まとめ。
> 最終更新: 2026-09-18（main へ統合した時点）

## 0. TL;DR

traP の Stripe 集金・払い戻しシステム「Checkin」。design.md（リポジトリ直下）が一次設計。
第一弾スコープ（①集金 ②入出金一覧 ③払い戻し）＋認証基盤＋利用者 UI＋会計 UI＋**重複支払い防止（発行台帳）**を **OpenSpec 仕様駆動**で実装済み。

- **全ゲート緑**: `pnpm lint` / `pnpm knip` / `pnpm typecheck` / `pnpm test` / `pnpm build`（テスト件数は `pnpm test` の出力で数える）。
- アーカイブ済みの change は `openspec/changes/archive/`、spec は `openspec/specs/` にある（件数は `ls -d openspec/changes/archive/*/ | wc -l` と `ls -d openspec/specs/*/ | wc -l` で数える）。
- 直近: `add-issuance-ledger`（半期スロット台帳で会員費の二重払いを拒否）。**実 Stripe で E2E 済み**（発行→支払い→再発行拒否／未払い時 URL 再利用／通期×半期の重複拒否）。Codex 2 周レビューで money-safety（draft-first 順序）を確定。
- **ローカル dev 構成**（下記 §10）: `.env`＋`apps/web/.env` symlink、Dev ログイン `/dev/login`、Stripe test キー＋`PRICE_*` 4 種＋`stripe listen` の配線。

## 1. スタック / レイアウト

- pnpm workspaces モノレポ。TypeScript strict / Node 24 / ESM。
- `apps/web` — Nuxt 4（UI ＋ Nitro サーバ。oRPC をホスト）。UI は `@nuxt/ui`（Tailwind v4）。
- `packages/api` — oRPC ルータ＋ドメイン（auth / billing / stripe / jomon / payouts / payments / notify / webhook）＋ Stripe を薄く包む管理・配管層（prices / products / invoices / checkout）。
- `packages/db` — Drizzle ORM + MariaDB（`mysql2`）。schema は `packages/db/src/schema.ts`、migration は `packages/db/drizzle/`（コミット対象）。
- 規約は `openspec/project.md` と `README.md` を参照。

主要ファイル:
- oRPC: `packages/api/src/router.ts`（`appRouter`。capability ごとのルータを束ねるだけ）, `packages/api/src/orpc.ts`（`Context` ＋ `pub`/`userProc`/`adminProc` ＋ 変更系ガード `assertMutationsEnabled`）。
- Nitro: `apps/web/server/routes/`（`rpc/[...].ts` マウント、`csrf`/`login`/`login/callback`/`logout`/`verify-email/confirm`/`webhook/invoice-paid`/`webhook/account-updated`）, `apps/web/server/utils/`（`auth.ts` の `buildRequestContext`、`*-config.ts`）。
- UI: `apps/web/app/`（`pages/`、`layouts/default.vue`、`composables/`、`plugins/orpc.ts`）。ページと composable の一覧は `ls apps/web/app/pages` と `ls apps/web/app/composables` で見る。

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

完了条件: lint/knip/typecheck/test/build 緑 ＋ 可能なら実サーバ＋MariaDB で E2E。

## 3. 実装済み

| capability (spec) | change | 要点 |
|---|---|---|
| identity | add-auth-foundation (+traq) | 本人キー=`mail_hash`（HMAC-SHA256）。`users.traq_id`(unique) で traQ 連結。メール平文は非保存（非 PII の Stripe/traQ 参照は可） |
| email-verification | add-auth-foundation | isct マジックリンク（`@m.isct.ac.jp`）。単回・期限・ハッシュ保存。Mailer アダプタ（log/SMTP） |
| session | add-auth-foundation (+traq) | **デュアル・アイデンティティ**: `{ traqId, isAdmin, userId, mailHash }`。`__Host-` cookie＋double-submit CSRF。`requireMember/User/Admin` |
| admin-authorization | add-auth-foundation (+traq) | traQ OAuth(PKCE)=**会員セッション**。会計は env 許可リスト・サブセット（`isAdmin`） |
| stripe-customer | add-membership-collection | Customer get-or-create（DB→検索→作成、競合安全）。アダプタ境界 |
| membership-billing | add-membership-collection (+traq, +bank-transfer) | 期判定（前期4-9/後期10-3、活動年度4/1-3/31）→ price 選択。`issueInvoice`(本人=mail_hash一致) / `issueSpecialInvoice`(会計のみ ¥2,000)。支払い時に traq_id 連結。**請求書はカード＋口座振込（`customer_balance`/`jp_bank_transfer`）両対応**（`add-bank-transfer-payment`、`createDraftInvoice` の `payment_settings`。着金は非同期で `invoice.paid` 経路に合流） |
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
- **認可順序**: `userProc`/`adminProc` は oRPC middleware で**入力検証より前**に走る（未認可で入力形状を漏らさない）。状態変更は `assertCsrf()`。
- **Stripe/Jomon 型はアダプタ層に隔離**。`billing/`・`payouts/`・`payments/` ドメインは SDK を直接呼ばない（型のみ可）。oRPC 出力はプレーン DTO。
- **メール平文を DB に保存しない**。ログイン中もセッションは `mailHash` のみ。請求時はメール再入力＋`mail_hash` 一致検証。

## 5. 残作業（優先度順）

### A. 実 Jomon 連携（**v1 ローカルで実接続 E2E 済み**。本番接続は Bearer 受け口のみ要調整）
**本番は v1（Jomon repo の `master` ブランチ）**。`v2` は default ブランチだが開発中の見込み。検証はローカルに clone した Jomon v1 で行った（`docker-compose up -d --build db jomon-server`、API は **:1323 直**、db は Checkin の 3306 と衝突しないポートに割り当て、Taskfile に `-buildvcs=false` を追加して起動）。
- **debug ビルド（`-tags debug`）は `AuthUser` がセッション/トークンを見ず常に admin `MyUser` 認証** → **ローカル検証では Bearer パッチ不要**。本番（`!debug`）に入れるときだけ `router/service.go` の `AuthUserMiddleware`/`AuthUser` に Bearer 受け口を足す（compose に `SERVICE_TOKEN` placeholder あり）。これが残る唯一の Jomon 側調整。
- **実 v1 で確定した連携**（`fix-jomon-v1-amount-multipayee` で Checkin v1 ドライバを実機整合に修正済み）: 一覧 `GET /api/applications?current_state=accepted`（素の配列）→ 詳細 `GET /api/applications/{id}` の `repayment_logs[].repaid_to_user.trap_id`＋`repaid_at`。**金額は per-payee に無く `current_detail.amount`（申請単位）**。書き戻し `PUT /api/applications/{id}/states/repaid/{trapId}` `{repaid_at:"YYYY-MM-DD"}`（**v1 は per-payee 書き戻しあり＝閉ループ可**。live 200 確認）。
- **複数 payee は自動送金せず needs-review＋UI 警告**（運用上は 1 人前提。総 payee 数≥2 ならマーカー化＝過払い防止。Codex HIGH 修正済み）。POST 申請は **multipart**（`-F 'details={...}'`）。
- **closed-loop E2E 完了**（`.env` を `JOMON_API_VERSION=v1` ＋ ローカル Jomon の `JOMON_API_BASE_URL` ＋ `JOMON_API_TOKEN=任意` に設定）: 単一 payee → `ingested:1`→本人解決→onboarding ゲート→**実 Stripe transfer（test mode）→ `paid` → Jomon に `repaid` 書き戻し（live 200）** まで通った。再実行は `already_paid`（二重送金なし）。複数/部分支払い → `multiPayeeRefs`＋`/payouts` 警告（送金せず）。
  - 送金は onboarding 済みのテスト connected account に devmember を DB で紐付け＋`done` にして実施（**新規 Express の onboarding 完了は hosted フロー必須**なので回避）。同じことをやり直す場合は、platform の available 残高が送金額以上あることを先に確かめる。
- **v2 は別系統で未整備**（per-payee 書き戻し API が無い＝`writeBackResult` は `JomonWriteBackUnsupportedError`）。v2 を採る場合は Jomon 側に書き戻し追加が要る。Checkin v2 ドライバも実 v2（`status=accepted`／素配列／`current_detail` 不使用…）に未整合の TODO 残（v1 に注力するなら不要）。

### B. Stripe 実 E2E（test キー投入で可能）
- 集金: `STRIPE_SECRET_KEY`(test) ＋ `PRICE_*`(4種) ＋ `STRIPE_WEBHOOK_SECRET` → `/membership` から発行→支払い→`invoice.paid` 通知。
- 払い戻し: Connect 有効な test キー ＋ `STRIPE_CONNECT_WEBHOOK_SECRET` → onboarding リンク→`account.updated`→`done`→transfer。
- 各 change の tasks.md 最後の E2E 項目が BLOCKED で残っている（キー投入後に実施）。

### C. 会計（管理）UI（✅ 実装済み = `add-accountant-ui`）
`/payments`（入出金一覧・フィルタ・append ページネーション・Dashboard リンク）と `/payouts`（払い戻し管理: `processApproved`/`list`/`execute`/`createOnboardingLink`/`onboardingStatus`）を実装済み。残りの会計 UI:
- **`/admins`**: 会計は env 許可リスト管理（旧 DB 管理者テーブルは deprecated）なので管理 UI は**意図的に未実装**。traQ グループ判定（後述 D）に移行する場合も UI は不要の見込み。
- **特別請求書発行 UI**（会計のみ ¥2,000）: ✅ 実装済み。`/special-invoice`（会計ナビ「特別発行」）でメールアドレスを指定して発行。`membership.issueSpecialInvoiceByEmail`（`email`/`name?`/`coverage`/`activityYear?`）が mail_hash で対象者を get-or-create するため**初見ユーザーも入力可**（user 検索 API は不要）。許可ドメイン宛のみ・hosted invoice URL を会計が本人へ転送。userId 指定の `issueSpecialInvoice` も従来どおり残置（共通ヘルパ `issueSpecialForRow` に集約）。

### D. ハードニング・フォローアップ
- `users.stripe_customer_id` に connected account 同様の **unique 制約＋get-or-create 競合対策**（Codex 指摘の後続）。小さな change。
- ~~集金の永続的発行台帳~~ → **完了**（`add-issuance-ledger`、半期スロット台帳）。
- traQ グループによる会計判定（現状は env 許可リスト `CHECKIN_ACCOUNTANT_TRAQ_IDS`）。
- ロゴ画像（現状テキスト）、`/payouts/onboarding/{refresh,return}` の戻り先ページ（Account Link 用、現状未作成）。

## 6. 環境変数（`.env.example` 参照）

必須(実運用): `DATABASE_URL`, `MAIL_HASH_SECRET`(不変運用), `APP_ORIGIN`, `CHECKIN_ACCOUNTANT_TRAQ_IDS`, `TRAQ_OAUTH_*`(登録済みクライアント), `MAILER_DRIVER`(+`SMTP_*`), `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/`PRICE_*`, `STRIPE_CONNECT_WEBHOOK_SECRET`, `JOMON_API_BASE_URL`/`JOMON_API_TOKEN`/`JOMON_API_VERSION`(default stub)。
runtime override は Nuxt の `NUXT_` 接頭辞（例 `NUXT_DATABASE_URL`、`NUXT_MAIL_HASH_SECRET`）。

## 7. ローカル実行・検証

```bash
pnpm install
docker compose up -d                 # MariaDB
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
- **oRPC 入力検証は middleware の後**（`userProc`/`adminProc` で認可が先）。cookie を扱う `/csrf`・`/login`・`/logout`・`/verify-email/confirm`・webhook は **Nitro ルート**（oRPC ではない）。
- **`git add -A` は change 境界を越えて作業ツリーの差分を巻き込む**ので、コミットする対象は名指しする。
- **@nuxt/ui `USelect` の選択肢に空文字 `value:''` は不可**（''は「選択クリア／placeholder」予約。ハイドレーション時に throw → ページが 500）。「すべて」等は `'all'` 等のセンチネル値にし、API へ渡す時に `=== 'all' ? undefined : v` で変換する。**lint/typecheck/build/Codex は検出できず、実ブラウザ（Playwright）でのみ顕在化**した（`add-accountant-ui` で発生・修正済み）。UI は実描画で確認すること。
- **会計 UI のローカル検証**: traQ OAuth 無しで会計セッションを偽造できる — `sessions` に `is_admin=1` 行を挿入（`id_hash = sha256hex(token)`）し、ブラウザに `__Host-checkin_session=<token>` を渡す。headless+http では Secure な CSRF cookie が保持されず mutation が 403 になるので、mutation は curl（`/csrf`→cookie＋`x-csrf-token` ヘッダ）で確認する。

- **発行は draft-first**（`packages/api/src/ledger/issue.ts` の `issueWithLedger`）: draft 作成→id 付きスロット予約→finalize。**ledger-first（予約→発行→id 書き戻し）にしてはいけない**（支払い可能 invoice がガード無しで残る窓ができる＝Codex HIGH）。`finalizeAndSendInvoice` は「draft のときだけ throw」不変条件・email は best-effort・`createDraftInvoice` は**非冪等**（同時発行が別 id を引くため。同一冪等キーだと敗者が勝者の invoice を void）。
- **Stripe 冪等キーのテスト汚染**: 同じ customer/price/year/feeType で過去に作った invoice が Stripe 側の冪等ウィンドウ（〜24h）に残ると、台帳を消しても再発行が「finalize 済み invoice を再 finalize」で 500。E2E は `/dev/login?as=user&email=<fresh>` で毎回新規 customer を使う。

## 9. 次の一手（推奨）

1. （並行）Jomon メンテナと Bearer 受け口＋v2 書き戻しを握る（残作業 A）。
2. Stripe/Connect の test キーが入ったら各 BLOCKED E2E を消化（残作業 B）。会計 UI（`/payments`・`/payouts`）も実データで E2E（`add-accountant-ui` の tasks 4.3/4.4）。
3. `stripe_customer_id` unique 化（残作業 D）。
4. ~~（任意）特別請求書発行 UI（会計が `coverage`/`activityYear` 指定）＋ user 検索 API~~ → **完了**（`/special-invoice`、メール指定で初見ユーザーも発行可。user 検索 API は不要に）。残: 実 Stripe キーでの発行→支払い E2E。
5. ~~（任意）銀行振込（`customer_balance`/`jp_bank_transfer`）~~ → **完了**（`add-bank-transfer-payment`、全請求書をカード＋口座振込の両対応に）。残: Stripe アカウントで JPY＋日本の銀行振込を有効化のうえ test mode E2E（archive の tasks 4.x が BLOCKED）。

## 10. ローカル dev 環境の作り方

- **`.env`**（root）＋ **`apps/web/.env` → `../../.env` symlink**（`nuxt dev` は rootDir=`apps/web` から `.env` を読むため必須。無いと `DATABASE_URL is not set`）。キーの一覧と意味は `.env.example` を参照。dev ログインを使うなら `CHECKIN_DEV_LOGIN="1"` を足す。
- **Dev ログイン** `GET /dev/login`（`apps/web/server/routes/dev/login.get.ts`）: `?as=admin|member|user|both`、`?email=`（user/both、既定 `dev-user@m.isct.ac.jp`）、`?redirect=`。**二重ガード**（`import.meta.dev` ＝本番ビルドで false に焼かれ 404 ＋ `CHECKIN_DEV_LOGIN=1`）で本番無効を実ビルドで検証済み。traQ OAuth 無しで会計/会員/利用者セッションを発行。
- **Stripe**: test secret key と `PRICE_*` 4 種を `.env` に入れる。webhook は `stripe listen --forward-to localhost:3000/webhook/invoice-paid --forward-connect-to localhost:3000/webhook/account-updated` で転送する（`--api-key` には `.env` の鍵を渡す。`stripe listen` が出す署名シークレットを両 webhook の secret に設定する）。
- 起動: `pnpm dev`（:3000）。MariaDB は `docker compose up -d`、マイグレーションは §7 の `pnpm db:migrate`。
