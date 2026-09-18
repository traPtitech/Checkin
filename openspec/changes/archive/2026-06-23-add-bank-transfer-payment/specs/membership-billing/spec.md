## MODIFIED Requirements

### Requirement: 請求書の作成・確定・送付

システムは、対象 Customer に対し Invoice ＋ InvoiceItem（選択した Price）を作成し、finalize して支払い可能にする SHALL。利用者は Stripe の支払いページ（`hosted_invoice_url`）で支払える MUST。請求書はドメイン非依存のアダプタ越しに作成する。

発行する Invoice は**カードと口座振込（銀行振込）の両方**で支払える SHALL：`payment_method_types` にカードと `customer_balance` を含め、`customer_balance` の funding を `jp_bank_transfer`（`funding_type = bank_transfer`）に設定する MUST。利用者は hosted invoice ページでいずれかの手段を選べる。口座振込は**非同期着金**であり、Invoice は着金まで `open` を維持する SHALL：利用者は表示される専用振込先へ振り込み、着金が Customer 残高に反映され Invoice へ充当されたとき、その入金は既存の入金確定経路（[[payment-webhook]]：`invoice.paid` → 会計通知・[[issuance-ledger]] の paid 確定）に合流する MUST。支払い手段の追加は重複防止・本人特定・発行順序のロジックを変更しては SHALL NOT。

発行は **発行台帳（[[issuance-ledger]]）のゲート越し**に行う SHALL。費目・期・区分から coverage（埋める半期）を決定し、対象半期を台帳で判定する MUST：
- 対象半期が **支払い済み**なら発行せず拒否する（既に支払い済み）。
- 対象半期が**未払いの同一発行（open）**で占有されているなら、新規発行せず**既存の支払いページ URL を返す**。
- 対象半期が既存発行と**期間重複**するなら拒否する。
- いずれでもなければ発行する。

発行は **支払い可能な Invoice がそれを守る台帳スロットを必ず伴う**順序で行う MUST（実装は draft 作成 → スロット予約 → finalize＝支払い可能化）。発行が途中失敗（finalize 失敗）した場合は、支払い不可の Invoice を後始末し予約スロットを解放してエラーを返す SHALL。連打・同時発行でも、台帳の一意制約により**単一の支払い可能 Invoice に収束**する MUST（決定的冪等キーには依存しない）。

#### Scenario: 発行で支払いページに到達できる

- **WHEN** 認可され、対象半期が未占有の請求書発行が要求される
- **THEN** 台帳にスロットが予約され、Customer の Invoice（Price 指定）が支払い可能化され、支払いページ（URL）が利用可能になる

#### Scenario: 請求書はカードと口座振込の両方で払える

- **WHEN** 請求書が発行される
- **THEN** その Invoice はカードと口座振込（`customer_balance` の `jp_bank_transfer`）の両方の支払い手段を備え、hosted invoice ページで利用者がいずれかを選べる

#### Scenario: 口座振込は着金まで open を維持し、着金後に入金確定へ合流

- **WHEN** 利用者が口座振込を選び、表示された専用振込先へ振り込む
- **THEN** 着金までは Invoice が `open` のまま保たれ、着金が Customer 残高に反映され Invoice へ充当されると `invoice.paid` 経路で会計通知と発行台帳の paid 確定が行われる

#### Scenario: 支払い済みの再発行は拒否

- **WHEN** 対象半期が既に支払い済みの利用者が、同じ年度・期の発行を要求する
- **THEN** 新しい Invoice は作られず、拒否される（既に支払い済み）

#### Scenario: 未払いの再要求は既存の支払いページを返す

- **WHEN** 対象半期に未払いの同一発行（open）が既にある状態で、同じ条件の発行が再要求される
- **THEN** 新しい Invoice は作られず、既存発行の支払いページ URL が返る

#### Scenario: 連打・同時発行でも単一 Invoice に収束

- **WHEN** 同一条件の発行要求が短時間に複数回／同時に届く
- **THEN** 台帳の一意制約により単一の支払い可能 Invoice に収束し、支払い可能 Invoice がガード無しで残らない
