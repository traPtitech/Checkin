# Checkin — Handover

> 引き継ぎ用。別エージェント／開発者が続きを進めるための現状・規約・残作業まとめ。
> 最終更新: 2026-06-21 / ブランチ: `claude/checkin-auth-collection`（未 push）

## 0. TL;DR

traP の Stripe 集金・払い戻しシステム「Checkin」。design.md（リポジトリ直下）が一次設計。
第一弾スコープ（①集金 ②入出金一覧 ③払い戻し）＋認証基盤＋利用者 UI を **OpenSpec 仕様駆動**で実装済み。

- **全ゲート緑**: `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test`（111 tests）。作業ツリーはクリーン。
- **8 changes をアーカイブ済み**（`openspec/changes/archive/`）、**11 specs**（`openspec/specs/`）。
- 未コミットなし。**push / PR は未実施**。
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

## 3. 実装済み（8 changes / 11 specs）

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

価格マトリクス（ユーザー確定）: 新規入部費=前期¥4,000/後期¥2,000（日付で自動、利用者発行）。継続(部費)=標準¥4,000（利用者）/特別¥2,000（**会計のみ**発行）。

## 4. 重要な設計判断・不変条件（壊さないこと）

- **本人キーは `mail_hash`**。traQ ID は**認証済みセッション由来のみ**連結（フォーム入力は信頼しない＝design §4.1）。Jomon payout は traQ ID で来るので `users.traq_id`→本人解決。
- **二重送金防止（payout）**: `payouts.jomon_ref` unique ＋ 冪等 upsert ＋ 原子的クレーム（`status=processing` への条件付き UPDATE、`paid`/`processing` 除外）＋ Stripe 冪等キー `payout:${jomonRef}` ＋ `paid` 早期 return。書き戻し失敗は再試行（送金は再実行しない、`jomon_written_back_at` で管理）。
- **集金の冪等**: `issueInvoice` に決定的 Stripe 冪等キー（連打抑止。永続的な発行台帳は未実装＝意図的後続）。
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

### C. 会計（管理）UI（未着手・次の自然な塊）
design §8 の `/payments`（入出金一覧、フィルタ・ページネーション）、`/admins`、払い戻し管理（onboarding リンク発行 `payouts.createOnboardingLink`、`payouts.processApproved`/`list`/`execute`）。バックエンド API は揃っているので UI のみ。`add-member-ui` のパターン（@nuxt/ui、`useAuthMe`/`useCsrf`、`adminProc` 系は会計セッション必須）を流用。新 change `add-accountant-ui` 推奨。

### D. ハードニング・フォローアップ
- `users.stripe_customer_id` に connected account 同様の **unique 制約＋get-or-create 競合対策**（Codex 指摘の後続）。小さな change。
- 集金の**永続的発行台帳**（期またぎ「既に発行/支払済み」判定。現状は Stripe 冪等キーで連打のみ抑止）。
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

## 9. 次の一手（推奨）

1. （並行）Jomon メンテナと Bearer 受け口＋v2 書き戻しを握る（残作業 A）。
2. `add-accountant-ui` を新 change で（残作業 C）。バックエンドは完成済み。
3. Stripe/Connect の test キーが入ったら各 BLOCKED E2E を消化（残作業 B）。
4. `stripe_customer_id` unique 化（残作業 D）。
