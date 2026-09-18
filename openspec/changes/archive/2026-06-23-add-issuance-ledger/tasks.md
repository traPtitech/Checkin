## 1. DB（発行台帳テーブル）

- [x] 1.1 `packages/db/src/schema.ts` に `membership_slots` を追加（`id`/`user_id`(FK)/`activity_year`(int)/`half`(enum zenki,kouki)/`charge_group`(uuid)/`stripe_invoice_id`/`status`(enum open,paid)/`created_at`/`updated_at`/`paid_at`(nullable)）。**UNIQUE `(user_id, activity_year, half)`**。money-safety で `stripe_invoice_id` は予約時に必ずセット（null スロット無し）
- [x] 1.2 `pnpm db:generate` で migration 生成（`0007_high_vermin.sql`、baseline 保持）。適用済み

## 2. ledger ドメイン（`packages/api/src/ledger/`）

- [x] 2.1 coverage 純関数（`coverage.ts`）: `standardCoverage`（標準）、`halvesForCoverage`、`standardActivityYear`（継続=翌年度）。特別 coverage は引数（zenki/kouki）
- [x] 2.2 store（`store.ts`）: `reserveSlots`（id 付き原子的 INSERT、UNIQUE 違反→'conflict'）/ `getSlots` / `getSlotsByChargeGroup` / `markPaidByInvoiceId`（冪等・open のみ）/ `releaseByChargeGroup`（DELETE 解放）
- [x] 2.3 判定＋発行（`issue.ts`）: `resolveIssuance`（読み取りのみ: paid/existing/conflict/free）＋ `issueWithLedger`（draft-first オーケストレーション、Stripe ops 注入でテスト可）
- [x] 2.4 ユニットテスト（`ledger.test.ts`、MariaDB バックド self-skip／coverage は常時）: 発行・open 再利用・paid 拒否・rule4 共存・部分重複拒否・finalize 失敗時の解放＋void。9 tests green

## 3. 発行を台帳ゲート化（`packages/api/src/router.ts` ＋ `stripe/invoices.ts`）

- [x] 3.1 `membership.issueInvoice`（標準・本人）: coverage 決定 → `issueWithLedger`（paid/重複=`CONFLICT` / 既存=同一 URL 再利用 / free=draft→予約→finalize）。Customer 解決は `createDraft` 内（free のみ）で副作用最小化
- [x] 3.2 `membership.issueSpecialInvoice`（特別・会計、常に ¥2,000）: 入力に `coverage`(`zenki`/`kouki`)＋`activityYear`(任意) を追加し台帳ゲート化。前期のみ＝`zenki`、後期追加＝`kouki`
- [x] 3.3 `stripe/invoices.ts`: `createDraftInvoice`（非冪等＝同時発行が別 id）/ `finalizeAndSendInvoice`（draft のときだけ throw＝money-safe 不変条件、email best-effort、finalize レース耐性）/ `voidInvoiceSafe`。旧 `issueInvoice`/`retrieveInvoice` は撤去
- [x] 3.4 拒否は `ORPCError('CONFLICT', …)`、出力 DTO は従来どおり `{ invoiceId, hostedInvoiceUrl }`

## 4. Webhook で paid 確定（`apps/web/server/routes/webhook/invoice-paid.post.ts`）

- [x] 4.1 検証済み `invoice.paid` の `objectId`（invoice id）で `markPaidByInvoiceId` を呼ぶ（台帳外は 0 件 no-op で 200）。通知/記録の前・独立。event id 冪等は従来どおり（`VerifiedEvent.objectId` を追加）

## 5. 検証

- [x] 5.1 `pnpm lint` / `pnpm typecheck` / `pnpm build` / `pnpm test`（120 tests）緑
- [x] 5.2 ローカル実 Stripe ＋ `stripe listen` で E2E 確認:
  - 発行 → 支払い(out-of-band) → `invoice.paid` で両スロット paid → 同条件の再発行が **CONFLICT「既に支払い済み」** ✓
  - 未払いのまま同条件を再要求 → **同一 invoice id / 支払いページ URL** が返る（新規 draft 作らない）✓
  - 通期を支払い済みで **後期のみ特別** を要求 → **重複拒否** ✓
  - 特別（会計）coverage=zenki / activityYear 指定で ¥2,000 半期発行 ✓
- [x] 5.3 Codex レビュー（money/concurrency）: 初回で HIGH×3（ledger-first の孤児削除レース／finalize 後の解放）→ **draft-first に再設計**して解消。再レビューで HIGH（send 失敗時の解放）→ finalizeAndSend を「draft のときだけ throw」不変条件＋email best-effort に修正。最終レビューで **全 resolved・残リスク無し** を確認
