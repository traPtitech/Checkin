## 1. DB スキーマとマイグレーション

- [x] 1.1 `packages/db/src/schema.ts` の `payouts` に `payout_method`（enum `['stripe_connect','manual_bank']`、`notNull().default('stripe_connect')`）、`manual_paid_at`（timestamp nullable）、`manual_paid_note`（varchar(255) nullable）、`manual_paid_by`（varchar(36) nullable、`references(() => users.id)`）を追加し、各カラムにコメントを付す
- [x] 1.2 drizzle マイグレーションを生成（既存の DB パッケージ手順に従う）。既存行が無変更で通る（default/nullable）ことを確認

## 2. ストア層（原子的確定）

- [x] 2.1 `packages/api/src/payouts/store.ts` の `PayoutRow` と `PAYOUT_COLUMNS` に `payoutMethod`（および表示用に `manualPaidNote`・`manualPaidAt`）を追加
- [x] 2.2 `markPayoutManuallyPaid(db, { jomonRef, note, byUserId })` を追加：単一の条件付き UPDATE で `status='paid'`・`payout_method='manual_bank'`・`manual_paid_at=NOW()`・`manual_paid_note`・`manual_paid_by` をセットし、`WHERE jomon_ref=? AND status IN ('pending','onboarding_waiting','failed')`。`affectedRows === 1` を真として返す（`claimPayoutForExecution` と同じ affectedRows 抽出）。`stripe_transfer_id` は触らない

## 3. オーケストレーション（手動 paid 確定）

- [x] 3.1 `packages/api/src/payouts/`（`execute.ts` か新 `manual.ts`）に `markPayoutManuallyPaid(deps, { jomonRef, note, byUserId })` を実装：(1) `getPayoutByJomonRef`、無ければ NOT_FOUND、(2) `paid` は短絡（書き戻し未了なら `reattemptWriteBack` のみ）／`processing` は `needs_review`、(3) store の原子的確定、(4) 負け（affectedRows=0）は再読込して短絡、(5) 勝ちは `tryWriteBack(deps, jomonRef, { status: 'paid', message: note })`、(6) `PayoutStepResult`（`outcome: 'paid'`）を返す
- [x] 3.2 Jomon の approved 一覧を pull しないこと（ローカル行のみで動く）と、`user_id` 不変条件の維持（null は許可、別人への再リンクはしない）を担保

## 4. API ルート

- [x] 4.1 `packages/api/src/router.ts` の `payouts` に `markManuallyPaid` を追加：`adminProc` ＋ `context.assertCsrf()`、入力 `z.object({ jomonRef: z.string().min(1), note: z.string().max(255).optional() })`
- [x] 4.2 実行者を**サーバセッションから解決**：`context.session.userId` を優先、null なら `context.session.traqId` から `getUserByTraqId` で会計の `users.id` を解決し `byUserId` として渡す（解決不能なら null）。`list` の status enum 等の既存型と整合させる

## 5. 会計 UI（`/payouts`）

- [x] 5.1 `apps/web/app/pages/payouts.vue` に per-row busy `Set`（`markingPaid`）と結果/エラー Record を `onExecute` と同じ流儀で追加し、`onMarkManuallyPaid(jomonRef, note)` で `$orpc.payouts.markManuallyPaid` を呼び `loadList()` 再取得
- [x] 5.2 「手動振込済みにする」ボタンを `row.status` が `pending`/`onboarding_waiting`/`failed` のときだけ表示（`paid`/`processing` では非表示）。参照メモ入力＋確認ダイアログ（確定時のみ送信）を実装。実行中は二重発火防止
- [x] 5.3 一覧に `payout_method`（手動振込バッジ）と参照メモを反映し、手動 paid 行が判別できるようにする

## 6. テストと検証

- [x] 6.1 ストア／オーケストレーションの単体テスト：claimable 状態からの手動 paid 成功、`paid`/`processing` 拒否、Stripe claim との競合で二重に paid にならない、書き戻し失敗の隔離・再試行、`user_id` null でも確定できる
- [x] 6.2 Jomon v1 書き戻しが手動 paid（`stripeTransferId` 無し）で `repaid` を送ること、v2 は未対応で `paid` 保持・再試行待ちになることを確認
- [x] 6.3 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test` がグリーン。可能なら実サーバ＋MariaDB(docker compose) で UI からの手動振込済み操作を E2E 確認
