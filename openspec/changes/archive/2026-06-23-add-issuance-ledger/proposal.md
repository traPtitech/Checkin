## Why

現状の集金は **重複支払いを防げない**。`membership.issueInvoice` は呼ぶたびに新しい Invoice を作り、決定的冪等キーは **Stripe の冪等ウィンドウ（約24h）内の連打**しか抑止しない（[[membership-billing]] の「連打しても重複請求書を作らない（冪等ウィンドウ内）」のみ）。永続的な「発行/支払い済み」台帳が無いため（HANDOVER §5D の意図的後続）、同一人物が**同じ年度の会員費を日をまたいで2回払える**。銀行振込（後続 change）は非同期なので更に起きやすい。利用者が二重に払えないようにする。

ユーザー確定の支払いルール（重複判定の前提）。**原則 ¥4,000＝通期 / ¥2,000＝半期1つ**:
- **前期の入部・復旧**: ¥4,000・通期（本人）。
- **後期の入部・復旧**: ¥2,000・後期のみ（本人）。
- **継続（会計が後期に開始）**: 標準 ¥4,000・通期（本人）。
- **特別事情（会計発行 ¥2,000）**: 前期のみ（前期の特別／継続特別）または後期のみ（前期のみだった人の後期追加）。会計が前期/後期を指定。

## What Changes

- **半期スロット台帳の導入**: 活動年度を **前期(zenki)/後期(kouki)** の2スロットに分け、`(user_id, activity_year, half)` を **UNIQUE** とする発行台帳 `membership_slots` を追加。1 回の発行が埋めるスロット（coverage）を定義する:
  - 通期（前期入部・復旧 ¥4,000 / 継続標準 ¥4,000）→ **[前期]＋[後期]** を原子的に予約。
  - 半期（後期入部・復旧 ¥2,000）→ **[後期]** のみ。
  - 特別（会計発行 ¥2,000）→ 会計が **前期のみ／後期のみ**を指定（通期は無い）。前期のみだった人の後期追加（ルール4）も別 charge で後期を予約。
- **発行を台帳ゲートにする**: `issueInvoice` / `issueSpecialInvoice` は Stripe 発行の前に対象スロットを判定する:
  - 対象スロットが **paid** → 拒否（「既に支払い済み」）。
  - 対象スロットが**同一発行の open**（同じ期の未払い請求が既にある）→ **新規発行せず既存の支払いページ URL を返す**（あなたの選択どおり）。
  - 対象スロットが**他発行と部分的に重複**（例: 後期が既発行なのに通期を要求）→ 拒否（期間重複）。
  - いずれも無ければ予約 → Stripe 発行 → スロットに invoice id を記録。
- **入金で台帳を確定**: `invoice.paid` Webhook は、その invoice の全スロットを **paid** にする（[[payment-webhook]] を拡張）。
- **void で解放**: 請求を取り消した（void/draft 削除）スロットは解放し再発行可能にする。
- 競合は **UNIQUE 制約＋原子的予約**で安全（二者同時発行は一方のみ成功、他方は既存 URL を返すか拒否）。

明確に**スコープ外**（後続）: 銀行振込（`customer_balance`/`jp_bank_transfer`）対応＝別 change（あなたの選択どおり）。前期入会で ¥2,000 にする会計承認パスの UI、過去分の遡及台帳バックフィル。

## Capabilities

### New Capabilities
- `issuance-ledger`: 会員費の発行/支払いを半期スロット `(user_id, activity_year, half)` で永続管理する台帳。coverage（前期/後期/通期）の定義、原子的予約と UNIQUE による重複拒否、open の既存 URL 再利用、`invoice.paid` での paid 確定、void での解放。Stripe 非依存のドメイン＋アダプタ越しの状態遷移。

### Modified Capabilities
- `membership-billing`: 請求書発行を**台帳ゲート**にする（発行前に重複を判定: paid 拒否 / open 再利用 / 重複拒否）。発行する coverage（埋める半期）を費目・期・区分から決定する規則を追加。
- `payment-webhook`: `invoice.paid` 受信時に、その invoice に対応する台帳スロットを **paid** に更新する責務を追加（通知は従来どおり）。

## Impact

- **DB（`packages/db`）**: 新テーブル `membership_slots`（`user_id`/`activity_year`/`half`/`charge_group`/`stripe_invoice_id`/`status`/timestamps、UNIQUE `(user_id, activity_year, half)`）＋ migration（コミット対象）。
- **API（`packages/api`）**: `issuance-ledger` ドメイン（store＋coverage＋予約/確定/解放）。`router.ts` の `membership.issueInvoice`/`issueSpecialInvoice` を台帳ゲート化。`issueSpecialInvoice` に coverage 指定を追加。`stripe/invoices.ts` の発行に invoice id をスロットへ書き戻す流れ。
- **Nitro**: `webhook/invoice-paid.post.ts` で paid 確定を呼ぶ。
- **既存修正との関係**: 適用済みの「invoice idempotency key をエンドポイント別にする」バグ修正の上に乗る（台帳が本命の重複ガードになり、Stripe 冪等キーは連打抑止に格下げ）。
- **検証**: ローカル実 Stripe で「発行→支払い→再発行が拒否」「未払い時は同一 URL 再取得」「通期と半期の重なり拒否」を E2E。lint/typecheck/build/test 緑。
