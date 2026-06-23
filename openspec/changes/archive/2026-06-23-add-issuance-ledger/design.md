## Context

[[membership-billing]] の集金は重複支払いを防げない（Stripe 冪等キーは約24hの連打抑止のみ、永続台帳なし）。利用者が同じ年度の会員費を二重に払えないようにする。ユーザー確定のルール（前期入会=通期¥4,000 / 後期入会・復帰=後期¥2,000 / 継続=通期¥4,000・会計承認で¥2,000）を、**半期スロット**で表現して重複を拒否する。

既存の足場:
- `computeActivityYear(date): number`（活動年度 4/1–3/31）、`computeTerm(date): 'zenki'|'kouki'`（前期 4–9 / 後期 10–3）。
- 発行は `router.ts` の `membership.issueInvoice`（本人・標準）/ `issueSpecialInvoice`（会計・特別¥2,000）。Stripe 発行は `stripe/invoices.ts` の `issueInvoice`。
- `invoice.paid` は `webhook/invoice-paid.post.ts`（署名検証＋event 冪等＋会計通知）。
- DB は `packages/db`（Drizzle / MariaDB）、migration はコミット対象。

## Goals / Non-Goals

**Goals:**
- 半期スロット `(user_id, activity_year, half)` の UNIQUE 台帳で、会員費の二重支払いを拒否。
- 通期＝両半期、半期＝片半期の coverage を原子的に予約。
- 未払い（open）の同一発行は既存 URL を再利用、paid は拒否、部分重複は拒否。
- `invoice.paid` でスロットを paid 確定、void で解放。

**Non-Goals:**
- 銀行振込（別 change）。前期入会¥2,000 承認の UI。過去分のバックフィル。Stripe Customer 単位の重複（本台帳は user_id 基準）。

## Decisions

### D1. テーブル `membership_slots`（1 行＝占有された半期スロット）

| 列 | 内容 |
| --- | --- |
| `id` | PK (uuid) |
| `user_id` | FK → users.id |
| `activity_year` | int（活動年度） |
| `half` | enum `zenki` / `kouki` |
| `charge_group` | uuid（1 回の発行が占める 1〜2 スロットを束ねる） |
| `stripe_invoice_id` | varchar（**予約時に必ずセット**＝draft invoice の id。null 状態のスロットは存在しない） |
| `status` | enum `open` / `paid` |
| `created_at` / `updated_at` / `paid_at` | |

- **UNIQUE `(user_id, activity_year, half)`**: これが重複防止の本体。1 人・1 年度・1 半期につき高々 1 スロット。
- 通期発行＝同一 `charge_group`・同一 `stripe_invoice_id` の **2 行**（zenki, kouki）。半期発行＝1 行。
- **void/draft 削除＝行を DELETE**（スロット解放）。よって `status` は `open`/`paid` の 2 値で足りる（void 行は残さない＝UNIQUE と両立）。
- `amount` は持たない（Stripe が source of truth）。kind/variant は当面持たない（必要なら後続）。
- **money-safety: スロットは常に invoice id を持つ**（後述 D3 の draft-first）。null-id の宙ぶらりんスロットが無いので、webhook は必ず突き合わせでき、「孤児予約の自動削除」も不要（＝削除レースが原理的に起きない）。

### D2. coverage の決定（埋める半期）

**原則: 金額が coverage を決める — ¥4,000＝通期（前期＋後期）、¥2,000＝半期1つ。** 通期と半期で混在する `full` 金額の特別はない。

| シナリオ | 時期 | 発行者 | 金額 | coverage | 既存パス |
| --- | --- | --- | --- | --- | --- |
| 入部・復旧 | 前期 | 本人 | ¥4,000 | `full` | `issueInvoice` new(zenki) |
| 入部・復旧 | 後期 | 本人 | ¥2,000 | `kouki` | `issueInvoice` new(kouki) |
| 継続（標準） | 後期に会計が開始 | 本人 | ¥4,000 | `full` | `issueInvoice` continuation |
| 特別事情（前期のみ） | 任意 | 会計 | ¥2,000 | `zenki` | `issueSpecialInvoice` coverage=zenki |
| 後期追加（前期のみだった人） | 後期 | 会計 | ¥2,000 | `kouki` | `issueSpecialInvoice` coverage=kouki |

- **標準（本人 `issueInvoice`）**: `new` は期で自動（前期→`full`¥4,000 / 後期→`kouki`¥2,000）、`continuation` は `full`¥4,000。復旧/再入部は `new` と同一（期ベース）。
- **特別（会計 `issueSpecialInvoice`、常に ¥2,000）**: coverage は **`zenki` または `kouki` のみ**（`full` は無い）。`issueSpecialInvoice` に `coverage`(`zenki`/`kouki`) 入力を追加。
  - 前期のみ特別（ルール1.3 / 3.2）→ `zenki`。
  - 後期追加（ルール4: 前期のみだった人が後期も所属）→ `kouki`。

coverage → 半期集合: `full`→{zenki,kouki}、`zenki`→{zenki}、`kouki`→{kouki}。

**ルール4 が半期スロットの正しさを裏付ける**: 前期のみ(¥2,000)を払った人に会計が後期のみ(¥2,000)を別発行 → 前期・後期が**別 charge_group の別スロット**で埋まる（部分重複ではなく、空いている後期スロットの新規予約）。`(user, year, half)` UNIQUE がこれを自然に許容しつつ、同じ半期の二重支払いだけを拒否する。

### D2-1. activity_year の決定（covers する年度）

スロットの `activity_year` は **その支払いがカバーする活動年度**であり、発行時刻の年度とは限らない:
- **入部・復旧・後期追加**: 現在の活動年度（`computeActivityYear(now)`）。
- **継続（ルール3: 後期に会計が開始）**: 翌活動年度の更新を集めるため、**`computeActivityYear(now) + 1`（次年度）**の通期をカバーする（ユーザー確定）。今年度を既に払った人とはキーが別になり衝突しない。

台帳の重複防止機構（半期スロット UNIQUE）自体は年度の決め方に依存しないため、年度算出は [[membership-billing]] 側の規則として確定する。

### D3. 台帳ゲートの発行フロー（draft-first＝money-safe な順序）

**不変条件: 支払い可能な invoice は、必ずそれを守るスロットを伴う。** これを満たすため「非支払いの draft を作る → そのidでスロット予約 → 予約完了後に finalize（支払い可能化）」の順にする（`reserveOrResolve` ではなく `resolveIssuance`＋`issueWithLedger`）:

1. `activity_year`、coverage→対象半期集合 H を決定。
2. **判定（読み取りのみ・無副作用）** `resolveIssuance`（同一 `(user_id, activity_year)` の H ∩ 既存スロット）:
   - `paid`: H のいずれかが paid → `CONFLICT`「既に支払い済み」。
   - `existing`: H 全体が単一 open `charge_group`（占有半期＝H 一致）→ その invoice を `finalizeAndSend`（draft なら finalize、既 finalized は URL を返すだけ）で **既存の支払いページを返す**（冪等再要求／クラッシュで残った draft の復旧も兼ねる）。
   - `conflict`: H が既存 open と部分重複（例: 後期 open に通期要求）→ `CONFLICT`「期間重複」。
   - `free`: 誰も占有なし → 3 へ。
3. **draft 作成**: `createDraftInvoice`（Invoice 作成＋InvoiceItem、**finalize しない＝まだ支払い不可**）。**冪等キーは使わない**（同時2発行が同一 id を引くと敗者が勝者の invoice を void してしまうため。台帳が重複ガード）。
4. **原子的予約（id 付き）**: 1 文の複数行 INSERT で H 各半期に `status='open'`・新規 `charge_group`・`stripe_invoice_id=<draft id>`。UNIQUE 違反（同時予約の敗者）→ 自分の draft を `voidInvoiceSafe` で破棄し 2 を再判定（多くは勝者の `existing` に収束）。
5. **finalize（支払い可能化）**: 予約成立後に `finalizeAndSend`。**失敗時のみ** invoice を void＋スロット解放。`finalizeAndSend` は「draft のまま＝支払い不可」のときだけ throw する不変条件なので、解放は常に安全（支払い可能な invoice をガードごと消すことは起きない）。email 送信は best-effort。

これにより「二者同時発行」「連打」「日跨ぎ再発行」全てが台帳で 1 回に収束し、かつ支払い可能 invoice がガード無しで残ることは原理的に無い。

### D4. `invoice.paid` での確定 / void での解放

- `webhook/invoice-paid.post.ts`: 検証済み `invoice.paid` の `invoice.id` で `membership_slots` を引き、該当 `charge_group` の全スロットを `status='paid'`・`paid_at` 設定。event id 冪等は従来どおり（paid 化も冪等＝既 paid は no-op）。
- 通知は従来どおり発火。台帳更新は通知と独立（どちらかの失敗で全体を壊さない）。
- void/draft 削除（発行途中失敗の後始末や会計の取消）: 対応スロット行を DELETE。

### D5. ドメイン境界

- `issuance-ledger` ドメイン（`packages/api/src/ledger/`）に store（予約/確定/解放/参照）と coverage 純関数を置く。Stripe/Jomon 型は触らない。`stripe_invoice_id` は不透明文字列として扱う。
- oRPC 出力は従来の DTO（`{ invoiceId, hostedInvoiceUrl }`）。拒否は `ORPCError('CONFLICT', …)`。

## Risks / Trade-offs

- **部分重複の扱い**を「拒否」に倒す（自動で残り半期だけ発行はしない）。シンプル・安全だが、後期既発行で通期を求めると会計対応が要る。→ 必要になれば後続で「残り半期のみ発行」を足す。
- **特別の coverage** は `zenki`/`kouki` の半期のみ（`full` 無し＝¥2,000 は常に半期）。会計が前期/後期を明示。
- **draft-first で book-keeping のゴミ**: 同時発行や finalize 失敗で void 済み draft が Stripe 側に少量残りうる（支払い不可なので money リスクは無い）。気になれば定期スイープ。
- **クラッシュで残った draft**: 予約 → finalize 前に落ちると open スロット＋draft invoice が残る。次回の同条件要求は `existing` → `finalizeAndSend` が draft を finalize して復旧（支払いページに到達できる）。
- **user 単位 vs Customer 単位**: 台帳は `user_id` 基準（mail_hash 本人）。同一人物が複数 user 行を持たない前提（[[identity]] の get-or-create で担保）。
- **Codex レビュー反映（money-safety）**: 旧 ledger-first 案（予約→発行→id 書き戻し）は「支払い可能 invoice がガード無しで残る窓」があった（孤児削除レース／finalize 後の解放）。draft-first ＋「finalizeAndSend は draft のときだけ throw」不変条件＋email best-effort で解消（Codex 再レビューで resolved 確認）。

## Migration Plan

1. `packages/db` に `membership_slots` を定義 → `pnpm db:generate` → migration コミット。UNIQUE `(user_id, activity_year, half)`。
2. `packages/api/src/ledger/`：coverage 純関数＋store（予約/確定/解放/参照）＋テスト。
3. `router.ts`：`issueInvoice`/`issueSpecialInvoice` を台帳ゲート化、`issueSpecialInvoice` に `coverage` 追加。
4. `webhook/invoice-paid.post.ts`：paid 確定を追加。
5. ローカル実 Stripe E2E（発行→支払い→再発行拒否 / 未払い時 URL 再利用 / 通期×半期の重複拒否）。lint/typecheck/build/test 緑。

## Resolved Decisions（確定）

- **継続（ルール3）の activity_year**: 後期に会計が開始する継続は **翌年度（current+1）の通期**をカバーする（ユーザー確定）。
- **特別（会計）の coverage**: `zenki`/`kouki` の2択（`full` 無し）。前期のみ＝`zenki`、後期追加＝`kouki`。
- **金額と coverage**: ¥4,000＝通期 / ¥2,000＝半期1つ。

## Open Questions

- 部分重複時に「残り半期のみ自動発行」まで今回やるか（本 change では拒否に留める提案。会計はルール4どおり後期のみを別発行する運用）。
- 会計が請求を取消す UI（void）は本 change の範囲外（API の解放だけ用意し、UI は後続）。
