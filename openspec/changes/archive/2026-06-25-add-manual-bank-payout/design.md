## Context

払い戻し（payout-execution）は Stripe Connect 一本道で、`pending → onboarding_waiting → processing → paid/failed` の状態機械（`packages/api/src/payouts/`）で動く。`paid` 確定は `createTransfer`（Stripe）成功時のみで、確定後に `JomonClient.writeBackResult` で Jomon へ settled を書き戻す（`jomon_written_back_at` で再試行管理）。

オンボーディングを完了できない受取人は `onboarding_waiting`（または本人未連結で `pending`）のまま止まり、会計が銀行から手で振り込んでも「支払い済み」として記録できない。Jomon の振込依頼も未処理のまま残る。本 change は、Stripe を経由しない**手動振込での `paid` 確定**を、既存の冪等・原子性・Jomon 書き戻しの作法を保ったまま追加する。

関連既存資産:
- 原子的クレーム `claimPayoutForExecution`（`store.ts:138`）= `CLAIMABLE_STATUSES = ['pending','onboarding_waiting','failed']` への条件付き UPDATE。`processing`/`paid` は対象外。
- Jomon 書き戻し `tryWriteBack`/`reattemptWriteBack`（`execute.ts:404-437`）= 成功時のみ `jomon_written_back_at` を記録、失敗は隔離して後で書き戻しのみ再試行。
- v1 書き戻し（`jomon/http.ts:227`）は `PUT .../states/repaid/{trapId}` に `repaid_at` を送るだけで、`stripeTransferId` に**依存しない**。
- 会計 UI `apps/web/app/pages/payouts.vue` の行操作（`onExecute` 等、per-row busy `Set` パターン）。

## Goals / Non-Goals

**Goals:**
- Stripe transfer を発行せずに、会計操作で payout を `paid` に確定する原子的パスを追加する。
- 対象は `pending` / `onboarding_waiting` / `failed` のみ。`paid` / `processing` は拒否（確定済み・実行中の上書き／二重支払いをしない）。
- DB に監査情報（`payout_method`・`manual_paid_at`・`manual_paid_note`・`manual_paid_by`）を記録する。
- 既存の `paid` と同様に Jomon へ settled を書き戻す（`stripe_transfer_id` 非依存、`manual_paid_note` で代替）。
- 会計 UI の各行に「手動振込済みにする」操作（参照メモ入力＋確認ダイアログ）を追加する。

**Non-Goals:**
- Stripe 送金フロー自体の変更（onboarding ゲート・transfer 実行・冪等キーはそのまま）。
- Jomon 側 API の拡張（v2 の書き戻し未対応は従来どおり；手動 paid でも v2 は書き戻し失敗→再試行待ちのまま）。
- 手動振込の金額編集（金額は既存 payout 行の `amount` を使う。誤りは別途の運用で対応）。
- 複数受取人申請（multiPayee）の手動払い：payout 行が存在しないため対象外（従来どおり needs-review）。

## Decisions

### D1: `payouts` に監査カラムを追加（後方互換）
`packages/db/src/schema.ts` の `payouts` に以下を追加し、drizzle マイグレーションを生成する:
- `payout_method` `mysqlEnum('payout_method', ['stripe_connect','manual_bank'])` `.notNull().default('stripe_connect')` — 既存行・既存 Stripe フローは既定値で不変。
- `manual_paid_at` `timestamp` nullable — 手動 paid の確定時刻。
- `manual_paid_note` `varchar(255)` nullable — 振込参照番号などの自由記述メモ。
- `manual_paid_by` `varchar(36)` nullable, `references(() => users.id)` — 実行した会計の `users.id`。

`PayoutRow` DTO（`store.ts:6`）と `PAYOUT_COLUMNS` に少なくとも `payoutMethod` を追加し、UI が手動振込行をバッジ表示できるようにする（`manualPaidNote`/`manualPaidAt` も DTO に載せて表示に使う）。

**代替案**: 別テーブル `manual_payouts` に外出し。→ 1 payout = 1 行の状態機械を二重管理になり冪等・原子性が複雑化するため不採用。payout 行に直接持たせる。

### D2: 単一の原子的条件付き UPDATE で確定（`processing` を経由しない）
`store.ts` に専用関数を追加:
```
markPayoutManuallyPaid(db, { jomonRef, note, byUserId }): Promise<boolean>
  UPDATE payouts
     SET status='paid', payout_method='manual_bank',
         manual_paid_at=NOW(), manual_paid_note=?, manual_paid_by=?
   WHERE jomon_ref=? AND status IN ('pending','onboarding_waiting','failed')
  // returns affectedRows === 1
```
`claimPayoutForExecution` と**同じ `CLAIMABLE_STATUSES` 述語**を使うので、Stripe 実行フローと手動確定が同一 `jomon_ref` に競合しても、先に WHERE を満たして UPDATE した方だけが勝ち、もう一方は `affectedRows=0` で短絡する。`stripe_transfer_id` は触らない（手動 paid は null のまま）。

**代替案**: 既存の `claimPayoutForExecution`（→`processing`）で claim してから `setPayoutStatus('paid')` の二段。→ 手動確定は claim と settle の間に外部 I/O が無いため、二段にする利点が無く、`processing` の中間状態を晒すだけ。単一 UPDATE が最小で同等に安全。不採用。

### D3: オーケストレーション関数 `markPayoutManuallyPaid`（Jomon 取込に依存しない）
`execute.ts`（または `payouts/manual.ts`）に追加。`processApproved`/`execute` と違い **Jomon の approved 一覧を pull しない**（依頼が approved から外れていても・受取人に connected account が無くても確定できることが要件の核心）。ローカル行だけで動く:
1. `getPayoutByJomonRef`。無ければエラー（NOT_FOUND）。
2. `status === 'paid'` → `already_paid` 相当で短絡（書き戻し未了なら `reattemptWriteBack` のみ）。`status === 'processing'` → `needs_review`（Stripe 実行中の上書き禁止）。
3. `markPayoutManuallyPaid(db, ...)` を実行。`affectedRows=0`（競合で負け）なら再読込して短絡（勝者が `paid` 済みなら書き戻し再試行のみ）。
4. 勝ったら `tryWriteBack(deps, jomonRef, { status: 'paid', message: note })` を呼ぶ（既存の隔離・再試行ロジックを再利用）。
5. `PayoutStepResult` を返す（`outcome: 'paid'`）。

本人特定の不変条件は維持: 既に `user_id` のある行はそのまま（再リンクしない）。`user_id` が null（オンボーディング未着手）でも手動確定は許可する。

### D4: Jomon 書き戻しは既存の型・経路をそのまま再利用
`JomonWriteBackResult`（`jomon/types.ts:44`）は `status:'paid'|'failed'` ＋ optional `stripeTransferId` ＋ optional `message` で、手動 paid は `{ status:'paid', message: note }`（`stripeTransferId` 省略）で表現できる。v1 ドライバは `repaid_at` のみ送り `stripeTransferId` 非依存なので**型変更不要**。`message` に手動振込の参照メモを載せる。v2 は従来どおり未対応（書き戻し失敗→`jomon_written_back_at` 未設定で再試行待ち、`paid` は保持）。

### D5: 新 oRPC route `payouts.markManuallyPaid`
`router.ts` の `payouts` に追加。`adminProc` ＋ `context.assertCsrf()`（状態変更）。
```
input: z.object({ jomonRef: z.string().min(1), note: z.string().max(255).optional() })
```
実行者（`manual_paid_by`）はクライアント入力ではなく**サーバのセッションから解決**する（なりすまし防止）。`context.session.userId` を優先し、null の場合は `context.session.traqId` から `getUserByTraqId` で会計の `users.id` を解決して用いる（traQ-only admin で `session.userId` が露出しないケースの保険）。解決できなければ `manual_paid_by` は null（監査は `manual_paid_at`＋`note` で担保）。

### D6: 会計 UI に行操作を追加
`payouts.vue`:
- per-row busy `Set`（`markingPaid`）と結果/エラー Record を `onExecute` と同じ流儀で追加。
- 「手動振込済みにする」ボタンは `row.status` が `pending`/`onboarding_waiting`/`failed` のときだけ表示（`paid`/`processing` では非表示）。
- クリックで参照メモ入力（`UInput`/`UTextarea`）＋確認ダイアログ（`UModal` もしくは `overlay.confirm` 相当）を出し、確定時のみ `$orpc.payouts.markManuallyPaid({ jomonRef, note })` を呼ぶ。誤確定防止のため確認必須。
- 成功後 `loadList()` で再取得。一覧に `payout_method`（手動振込バッジ）・参照メモを反映。実行中は二重発火を防ぐ。

## Risks / Trade-offs

- **[Stripe 実行と手動確定の競合で二重支払い]** → D2 の単一原子的 UPDATE が `claimPayoutForExecution` と同じ `CLAIMABLE_STATUSES` 述語を共有。先に確定した側だけが勝ち、もう一方は `affectedRows=0` で短絡。Stripe 側は加えて冪等キー `payout:${ref}` が最後の砦。
- **[既に Stripe で paid 済みを手動上書き]** → WHERE が `paid`/`processing` を除外するため UPDATE が当たらず不可。route 側でも事前に `paid`/`processing` を弾く。
- **[誤った金額／受取人で手動 paid]** → 金額は既存 payout 行の `amount` を使用（編集不可）。実行は会計の責任で、参照メモ＋実行者＋日時を監査として残す。`user_id` 不変条件は維持。
- **[v1 書き戻しが trapId を要するが user 未連結]** → 書き戻しは既存どおり失敗を隔離（warning ログ＋`jomon_written_back_at` 未設定で再試行待ち）。payout のローカル `paid` は保持されるので業務は進む。v2 は従来どおり書き戻し未対応。
- **[`manual_paid_by` が null になりうる]** → traQ-only admin で userId 未解決のときは null 許容。`manual_paid_at`＋`note` で最低限の監査は残る。

## Migration Plan

1. `schema.ts` にカラム追加 → `pnpm --filter @checkin/db ...`（既存の drizzle 生成手順）でマイグレーション生成。すべて nullable もしくは default 付きなので既存行は無変更（`payout_method` は `stripe_connect` 既定）。
2. API（store/orchestration/router）→ UI の順で実装。
3. ロールバック: 追加カラムは加算的。切り戻す場合は逆マイグレーションでカラム削除（手動 paid 済みデータは失われるため、本番投入後は前進修正を基本とする）。

## Open Questions

- 一覧に手動振込専用カラム（参照メモ・実行者・日時）を常時表示するか、`payout_method` バッジ＋詳細展開に留めるか → UI 実装時に最小（バッジ＋メモ表示）で開始し、必要なら拡張。
- 手動 paid の取り消し（誤確定の是正）操作を将来用意するか → 本 change では Non-Goal。必要になれば別 change。
