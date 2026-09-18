## Context

[[add-auth-foundation]] でセッション・本人識別（`mail_hash`／`users`）・認可ヘルパ（`requireUser`/`requireAdmin`）・CSRF が整った。本 change はその上に第一弾スコープ①「集金」のバックエンドを乗せる。design.md（リポジトリ直下）§3/§5.1/§7 と整合。

確定済みの価格・運用（ユーザー合意）:

- 新規入部費: 前期(4–9月)¥4,000 / 後期(10–3月)¥2,000。活動年度 4/1–3/31、前期=4–9月・後期=10–3月。利用者が自己発行。
- 継続(部費): 標準¥4,000（利用者が自己発行）/ 特別¥2,000（**管理者のみ**が対象指定で発行）。
- 価格は `price_id` で指定（Product 単体では金額が定まらないため）。

制約: Stripe は test mode で開始。Stripe 依存はアダプタに隔離（切り替え可能性の担保）。メール平文は DB に保存しない。

## Goals / Non-Goals

**Goals:**
- Stripe アダプタ層を境界として導入し、集金ドメインを Stripe 非依存に保つ。
- `mail_hash` ↔ Stripe Customer の get-or-create と `stripe_customer_id` の永続化。
- 費目・期・標準/特別から `price_id` を決定し、Invoice を作成→finalize→send。
- 発行の認可（標準=本人のみ／特別=管理者のみ）。
- `invoice.paid` Webhook の署名検証・冪等処理・会計通知。

**Non-Goals:**
- `/membership` の UI 振り分け・フォーム（後続 change）。
- 入出金一覧 `/list/*`（後続、Stripe から直接取得）。
- 払い戻し・Jomon 連携・Connect onboarding（後続）。
- resend/催促、任意額請求書、資金繰り。

## Decisions

### D1. 依存とディレクトリ

- `stripe` 公式 SDK を `packages/api` に追加。
- `packages/api/src/stripe/`（アダプタ）: `customers.ts`（get-or-create/search/create）、`invoices.ts`（create+item+finalize+send）、`client.ts`（SDK 初期化、env から `STRIPE_SECRET_KEY`）、`webhook.ts`（`constructEvent` 署名検証）。
- `packages/api/src/billing/`（ドメイン、Stripe 非依存）: `term.ts`（期判定）、`pricing.ts`（費目・期・区分→`price_id`）、`authorize.ts`（発行認可）。

### D2. データモデル（`packages/db`）

- `users` に `stripe_customer_id varchar(255) nullable` を追加（identity の MODIFIED と整合：非 PII 参照は保持可）。
- `stripe_events` 追加（Webhook 冪等）: `event_id varchar(255)` unique, `type varchar`, `received_at timestamp default now`。
- 請求書自体は DB に持たない（source は Stripe。一覧は後続 change が Stripe から取得）。
- `pnpm db:generate` でマイグレーション生成・コミット。**注意**: 既存マイグレーションとの列追加 diff で drizzle-kit が対話を求める場合は、列追加は新規 ALTER として生成（rename 誤検出に注意。必要なら明示的に新規列として進める）。

### D3. Customer の get-or-create（順序）

1. `users.stripe_customer_id` があれば使用。
2. 無ければ提出メールで Stripe 検索（`customers.search` か `customers.list({email})`）。一致あれば採用し DB 保存。
3. 無ければ `customers.create({ email, name, metadata: { mail_hash, traq_id? } })` → DB 保存。

メール平文は (2)(3) の一時利用のみ。`traq_id` は metadata/ログ用で参照キーにはしない（信頼できないため）。

### D4. 価格決定（ドメイン）

- env: `PRICE_SHINKI_ZENKI`(新規前期¥4,000) / `PRICE_SHINKI_KOUKI`(新規後期¥2,000) / `PRICE_KEIZOKU_STANDARD`(継続標準¥4,000) / `PRICE_KEIZOKU_SPECIAL`(継続特別¥2,000)。
- `computeTerm(date)`: 月 4–9 → `zenki` / 10–12,1–3 → `kouki`（活動年度は会計年度ラベル用に併せて算出可）。
- `selectPriceId({ feeType, term, variant })`:
  - `feeType=new` → `term==='zenki' ? PRICE_SHINKI_ZENKI : PRICE_SHINKI_KOUKI`
  - `feeType=continuation, variant=standard` → `PRICE_KEIZOKU_STANDARD`
  - `feeType=continuation, variant=special` → `PRICE_KEIZOKU_SPECIAL`

### D5. 発行 API（oRPC）と認可

- `membership.issueInvoice`（`requireUser` ＋ `assertCsrf`）: input `{ email, name, feeType: 'new' | 'continuation' }`。
  - `deriveMailHash(email, secret) === session.mailHash` を検証（他人の分を発行不可）。不一致は `FORBIDDEN`。
  - `variant='standard'`（特別は不可）。`feeType=new` は `computeTerm(now)` で price 決定。
  - Customer を get-or-create → Invoice 作成→finalize→send。
- `membership.issueSpecialInvoice`（`requireAdmin` ＋ `assertCsrf`）: input `{ userId, name?, email? }`。
  - 対象 `users` 行を取得。`stripe_customer_id` があればそれを使用。無ければ `email`（必須）で Customer 作成。
  - `PRICE_KEIZOKU_SPECIAL` で Invoice 作成→finalize→send。
- 返り値: `{ invoiceId, hostedInvoiceUrl? }`（Dashboard/支払い URL は Stripe レスポンスから）。

### D6. Webhook（Nitro）

- `apps/web/server/routes/webhook/invoice-paid.post.ts`。**raw body** が必須（`readRawBody(event)`）→ `stripe.webhooks.constructEvent(raw, sig, STRIPE_WEBHOOK_SECRET)`。
- 冪等: `stripe_events` に `event_id` を unique 挿入。重複（既処理）ならスキップ。
- 副作用: `Notifier.notify(...)`（`LogNotifier` 実装で会計向けメッセージ。将来 traQ 通知等へ差し替え）。
- CSRF/セッションは適用しない（Stripe→サーバの署名認証で代替）。oRPC マウントの CSRF 配線とは別ルート。

### D7. Notifier 抽象

`interface Notifier { notify(message): Promise<void> }`、`LogNotifier`（dev/当面）。env で将来切替。`Mailer` と同様にドメインから具体実装を隠す。

### D8. 環境変数（`.env.example` 追記）

`STRIPE_SECRET_KEY`(test)、`STRIPE_WEBHOOK_SECRET`、`PRICE_SHINKI_ZENKI`/`PRICE_SHINKI_KOUKI`/`PRICE_KEIZOKU_STANDARD`/`PRICE_KEIZOKU_SPECIAL`、`INVOICE_DAYS_UNTIL_DUE`(既定 7 等)。`AuthConfig` と並ぶ `BillingConfig` を `packages/api` に型定義し、Nitro が runtimeConfig から解決して Context に載せる。

## Risks / Trade-offs

- **ログイン後にメール平文を持たない** → Customer 作成・送付に必要。Mitigation: 発行 API でメールを再提出させ、`mail_hash` 一致を検証（平文は一時利用、保存しない）。UX は後続 UI change で吸収。
- **Stripe 二重発行**（連打）→ Mitigation: Invoice 作成に決定的な冪等キー（`idempotencyKey`）を付与し、連打を Stripe の冪等ウィンドウ内で重複排除する。**Follow-up（意図的に後続）**: 期をまたいだ「既に発行済み／支払済み」を判定する永続的な発行台帳は本 change のスコープ外。冪等キーは短時間の二重 submit のみを抑止するもので、台帳ではない。
- **Webhook の順序・再送** → Mitigation: `event_id` 冪等。`invoice.paid` 以外は無視。
- **drizzle-kit の列追加対話** → Mitigation: 非対話で生成できるよう列を新規追加として扱う（rename 誤検出回避）。
- **テスト mode キー未投入**では E2E 不可 → Mitigation: 期判定・価格・認可はユニットテスト。アダプタは型・ビルドで担保し、キー投入後に E2E。

## Migration Plan

1. `stripe` 追加、`users.stripe_customer_id` ＋ `stripe_events` のスキーマ追加 → `pnpm db:generate` → migrate。
2. Stripe アダプタ（client/customers/invoices/webhook）→ billing ドメイン（term/pricing/authorize）→ oRPC 発行 API → Webhook ルート → `.env.example`。
3. ユニットテスト（term/pricing/authorize）。
4. test mode キー投入後、Stripe sandbox で発行→支払い→`invoice.paid` 通知の E2E。
5. ロールバック: 本 change のマイグレーション revert ＋ 発行 API/Webhook を無効化（後続未着手なら影響局所）。

## Open Questions

- `customers.search`（要 Search API 有効）か `customers.list({email})` か（実装で確定。list で十分な見込み）。
- `hosted_invoice_url` を返却に含めるか（送付はメールだが、UI 表示用に返すと便利）。実装で含める方針。
- 継続(部費)の「対象年度」表記を Invoice description/metadata にどう持たせるか（活動年度ラベル）。実装で metadata に付与。
