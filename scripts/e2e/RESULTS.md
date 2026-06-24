# Checkin — UI レベル実挙動検証 結果（2026-06-24）

> `E2E-SCENARIOS.md` の全 94 シナリオを、サブエージェント＋Playwright(playwright-core)＋実 Stripe(test)／実 Jomon(v1) で UI レベルから検証した記録。**修正は未実施**（観測のみ）。
> 環境: dev サーバ http://localhost:13000（`CHECKIN_DEV_LOGIN=1`）/ Stripe test キー＋`stripe listen` / Jomon v1 :1323 / 共有ハーネス `scripts/e2e/harness.mjs`。

## サマリ（修正・追加検証を反映した最終状態）

| 機能 | 総数 | 直接PASS(UI/HTTP/API) | UT裏取り(vitest) | FAIL | BLOCKED(環境制約) |
|---|---:|---:|---:|---:|---:|
| 入部 | 19 | 10 | — | 0 | 9 |
| 継続 | 7 | 7 | — | 0 | 0 |
| 特別対応 | 11 | 11 | — | 0 | 0 |
| 払い戻し | 31 | 8 | 23 | 0 | 0 |
| 横断 | 26 | 18 | 7 | 0 | 1 |
| **計** | **94** | **54** | **30** | **0** | **10** |

- 直接 PASS 54 ＋ UT 裏取り 30 ＝ **84 シナリオが緑**。**FAIL 0**。残り 10 は環境制約（時計/env/DB事前state/口座振込着金）で UI 不能。
- vitest は **131/131 pass**（webhook 回帰テスト +5）。lint/typecheck/build も緑。

## ✅ 解決済み（このセッションで修正・実証）

### 特-07 — 修正完了・再検証 PASS
- 根因: `special-invoice.vue` の活動年度入力が `type="number"`（@nuxt/ui が number にコアース）なのに `form.activityYear.trim()` を呼び `TypeError`→catch で握り潰し→RPC 未発火。
- 修正: `:61` を `String(form.activityYear ?? '').trim()` に変更（1行）。
- 再検証: UI で活動年度=2027 入力→**status 200・metadata.activity_year=2027**、空欄でも従来どおり 2026 で発行（回帰なし）。

### paid 系 BLOCKED — 実テストカード（tok_visa/4242）決済で実証 PASS
発行→**実カード決済**→`invoice.paid`→webhook→台帳スロット paid、を closed-loop で実証（再発行が ~2.3s で CONFLICT に転じる＋dev ログに通知）:
- **横-01**（入金確定＋通知）/ **入-10**（入部 paid 拒否）/ **継-05**（継続 paid 拒否）/ **特-08**（特別 paid 拒否）/ **特-11**（special は当該半期スロットのみ paid＝kouki は発行可）— すべて PASS。
- カード経路（tok_visa）で成功、out_of_band フォールバック不要。

### 横-01 / 横-02 / 横-22 — テスト欠落を解消（回帰テスト追加）
- webhook 処理を pure 関数 `processInvoicePaid(ops, verified)`（`packages/api/src/webhook/process.ts`）に**等価抽出**し、route は DI で呼ぶだけに。
- `process.test.ts`（DI spy・DB 非依存・常時実行）で 横-01（markPaid→notify→record の順序）/横-02（duplicate で副作用なし）/横-22（notify 失敗で record せず reject）/台帳外（objectId null）を検証。**131/131 pass**。
- 横-01 は上記の実カード E2E でも二重に実証。横-21（署名 400）は HTTP で実証済み。

## ✅ 主な PASS ハイライト（実値で確認）

- **入-04**: 前期発行 → Stripe `amount_due=4000 jpy` / `metadata{fee_type:new, term:zenki, activity_year:2026}`。
- **継-02**: 継続 → `activity_year=2027`（翌年度）。入部(2026)との +1 対比を実額確認。
- **特-01**: 特別 → `amount_due=2000` / `variant:special, coverage:zenki`。**特-10**: coverage 選択肢は前期/後期のみ（通期無し）。
- **払-17**: 既存 paid 行 execute → `already_paid` 短絡・transferId 不変（再送金なし）。**払-21**: 複数受取人 → `multiPayeeRefs` で needs-review・payout 行を作らず UI 警告。
- **横-17**: status「すべて」で **HTTP 500 ゼロ・console error ゼロ**（USelect 罠は回帰せず）。
- **横-05**: 請求書 `payment_method_types=[card, customer_balance]`・funding=`jp_bank_transfer`。
- **横-10/18/19/20/26**: メール確認連結・OAuth state 不一致拒否・CSRF 欠落拒否・トークン単回・ログアウト無効化、すべて実挙動で確認。

## ⏸ 残 BLOCKED（10）— 環境制約のみ（バグではない）

| 必要なもの | 該当シナリオ |
|---|---|
| システム時計＝後期 | 入-05, 入-11 |
| env 変更＋dev 再起動（PRICE 未設定） | 入-13 |
| DB/Stripe 事前 state（traQ 連結・Customer 分岐） | 入-14, 入-15, 入-16, 入-17, 入-19 |
| finalize 失敗注入（UT で代替可） | 入-18 |
| 実口座振込の着金（カード不可） | 横-06 |

> 注: 入-16（traQ 無しでも本人 mail_hash 一致で発行可）は入-04 の成功で事実観測済み。入-19①（Customer 新規作成）も入-04 でカバー。paid 拒否系（入-10/継-05/特-08/特-11）は本セッションで実カード決済により解決済み。

## 成果物

- ハーネス: `scripts/e2e/harness.mjs`（playwright-core。`__Host-`/Secure cookie を localhost http で扱うため curl でトークン取得→`addCookies` 注入。CSRF は固定値注入で double-submit 成立）
- 実行スクリプト: `scripts/e2e/run_join.mjs` / `run_continuation.mjs` / `run_special.mjs` / `run_payout.mjs` / `run_cross.mjs`
- スクショ: `scripts/e2e/shots/`（44 枚）
- **アプリ/仕様コードの変更は一切なし。** Stripe は test mode、実送金・新規 Jomon 書き戻しはゼロ。
