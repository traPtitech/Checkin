## Context

[[add-connect-onboarding]] で connected account の get-or-create・onboarding・`payout_onboarding_status` が整った。本 change は Jomon の承認済み振込依頼を取り込み、Stripe で送金し、結果を Jomon に書き戻す（design.md §5.3）。責任分界は確定: 承認・申請は Jomon、Checkin は実行のみ。連携は pull。Jomon は v1/v2 両対応＋stub 先行（[[jomon-integration]]）。

## Goals / Non-Goals

**Goals:**
- `JomonClient` アダプタ（取得・書き戻し、`stub`/`v1`/`v2`、Bearer トークン）。
- `payouts` テーブルと状態機械（pending/onboarding_waiting/paid/failed）、`jomon_ref` 冪等。
- 本人特定（mail_hash）→ onboarding 判定 → Stripe transfer（冪等）→ Jomon 書き戻し。
- 会計のみの操作。

**Non-Goals:**
- Jomon 側トークン受け口の実装、資金繰り、`/payouts` UI、汎用 transfers 一覧、account.updated からの自動再開（将来）。

## Decisions

### D1. Jomon アダプタ（`packages/api/src/jomon/`）

- `JomonClient` インターフェース:
  - `listApprovedTransferRequests(): Promise<JomonTransferRequest[]>`
  - `writeBackResult(jomonRef, result: { status: 'paid'|'failed', stripeTransferId?, message? }): Promise<void>`
- `JomonTransferRequest`（ドメイン DTO, Jomon 型非依存）: `{ jomonRef, payeeEmail, amount, currency }`。
  - **未確定**: 受取人識別子。当面 `payeeEmail`（isct メール）を採用し `deriveMailHash` で対応表に解決する想定。実フィールド名/形は実接続時に v1/v2 アダプタで確定（design.md §9、要 Jomon 調整）。
- 実装: `StubJomonClient`（メモリ/固定データ、dev・テスト用、機能完結）、`JomonV1Client` / `JomonV2Client`（`JOMON_API_BASE_URL` ＋ `Authorization: Bearer JOMON_API_TOKEN`、v1/v2 のパス差を吸収。フィールドマッピングは TODO コメントで明示し、実接続時に確定）。
- `createJomonClient(config)`: `JOMON_API_VERSION`（`stub`|`v1`|`v2`）で選択。

### D2. データモデル（`packages/db`）

`payouts`:
- `id` varchar(36) PK
- `jomonRef` varchar(255) **unique**
- `userId` varchar(36) FK→users（nullable: 未特定時）
- `amount` int、`currency` varchar(8)
- `status` enum(`pending`,`onboarding_waiting`,`paid`,`failed`) NOT NULL default `pending`
- `stripeTransferId` varchar(255) nullable
- `createdAt`/`updatedAt`
- 取込は `jomon_ref` で冪等 upsert（`INSERT ... ON DUPLICATE KEY UPDATE` no-op パターン、既存実装に倣う）。
- `pnpm db:generate`（`0004_*`、baseline 0000–0003 保持）。

### D3. Stripe 送金アダプタ（`packages/api/src/stripe/transfers.ts`）

- `createTransfer(client, { destinationAccountId, amount, currency, idempotencyKey, metadata })` → `transfers.create({ amount, currency, destination }, { idempotencyKey })`。idempotencyKey は `payout:${jomonRef}`。返却は `{ transferId }`。Stripe 型はアダプタ内に閉じ込める。

### D4. 実行オーケストレーション（`packages/api/src/payouts/execute.ts`、Stripe/Jomon 非依存のドメイン＋薄い配線）

- 純粋な状態遷移ヘルパ: `nextPayoutStatus(current, { onboardingDone, transferOk })` 等（テスト可能）。
- オーケストレーション（DB＋アダプタを引数で受ける）:
  1. `client.listApprovedTransferRequests()` → 各 req を `jomon_ref` で upsert（status 既定 pending）。
  2. 本人特定: `deriveMailHash(payeeEmail)` → `getUserByMailHash`。無ければ `payouts.userId=null` のまま「要対応」、送金しない。
  3. `payout_onboarding_status !== 'done'` → `getOrCreateConnectedAccount` ＋ `createAccountOnboardingLink`、status=`onboarding_waiting`（リンクは結果に含める／会計が受取人へ案内）。
  4. `done` → `createTransfer`（冪等キー `payout:${jomonRef}`）→ 成功 `paid`＋`stripeTransferId` / 失敗 `failed`。
  5. 確定後 `client.writeBackResult(...)`。
- 冪等: `paid` は再実行しない（早期 return）。`onboarding_waiting` は再実行で `done` を再評価。

### D5. oRPC（会計のみ, `adminProc`）

- `payouts.processApproved`（`adminProc`＋`assertCsrf`）: 取込→各 req を 1 ステップ進める→結果サマリ返却（実行件数・待機件数・要対応件数）。
- `payouts.list`（`adminProc`）: `payouts` 一覧（フィルタ status、ページング簡易）。
- `payouts.execute`（`adminProc`＋`assertCsrf`、`{ jomonRef }`）: 単一 payout を進める（待機分の手動再開・再試行用）。
- Context に `jomon: JomonClient` を追加（`buildRequestContext` で `createJomonClient` を遅延生成）。

### D6. 設定

`JOMON_API_BASE_URL` / `JOMON_API_TOKEN` / `JOMON_API_VERSION`(`stub`|`v1`|`v2`, 既定 `stub`) を `JomonConfig`（packages/api）＋ runtimeConfig ＋ `.env.example` に追加。送金通貨の既定（`PAYOUT_CURRENCY`, 既定 `jpy`）も env に。

## Risks / Trade-offs

- **受取人識別子→mail_hash の対応が未確定** → Mitigation: アダプタ契約で `payeeEmail` を採用しドメインは mail_hash に解決。実フィールドは実接続時に確定（要 Jomon 調整）。特定不可は送金せず要対応化。
- **二重送金** → Mitigation: `jomon_ref` unique ＋ Stripe 冪等キー ＋ `paid` 早期 return。
- **送金成功後の書き戻し失敗** → Mitigation: payout は `paid`＋`stripe_transfer_id` を source として保持。書き戻しは再試行可能（次回 processApproved で paid かつ未書き戻しを再送）。実装で「書き戻し済み」フラグ or 冪等な書き戻しを検討。
- **stub と実 API の乖離** → Mitigation: v1/v2 アダプタはフィールドマッピングを TODO 明示。実接続時に schema 確定。
- **Jomon 側トークン受け口未整備** → 本 change は stub で完結、実接続は後続調整。

## Migration Plan

1. `payouts` テーブル追加 → `pnpm db:generate`（0004）→ migrate。
2. Jomon アダプタ（interface＋stub＋v1/v2 scaffold）→ Stripe transfers アダプタ → 実行オーケストレーション → oRPC → 設定。
3. ユニットテスト（本人特定、状態遷移、冪等 upsert、stub クライアントでのフロー）。
4. Jomon トークン受け口＋Connect 有効キー入手後、sandbox で取込→onboarding→送金→書き戻しの E2E。
5. ロールバック: マイグレーション revert ＋ payouts 手続き無効化。

## Open Questions

- Jomon 振込依頼の受取人識別子（isct メール？traQ？内部 id？）→ 実接続時に確定（design.md §9）。
- v1/v2 のエンドポイント・スキーマ差（取得・書き戻しのパス／フィールド）→ 実接続時に v1/v2 アダプタで確定。
- 送金は transfer（platform→connected）で確定。connected からの bank payout は Stripe の payout schedule に委ねる（必要なら明示 payout を将来追加）。
- 書き戻し冪等（フラグ列を payouts に足すか）→ 実装で判断（まずは paid 再送を許容しても Jomon 側冪等なら可）。
