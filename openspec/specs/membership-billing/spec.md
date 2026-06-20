# membership-billing

## Purpose

集金（入部費 / 部費）のドメイン。活動年度に基づく期判定、費目・期・標準/特別から `price_id` を決定する規則、発行の認可（標準は本人・特別は管理者）、Invoice の作成→finalize→send を Stripe 非依存に定義する。

## Requirements

### Requirement: 活動年度に基づく期判定

システムは、活動年度を 4月1日〜翌年3月31日とし、4月1日〜9月30日を**前期**、10月1日〜翌年3月31日を**後期**として、与えられた日付から半期を決定 SHALL。判定は決定的で、月によって一意に定まる MUST。

#### Scenario: 前期の日付

- **WHEN** 判定対象の日付が 4〜9 月のいずれか
- **THEN** 期は「前期」と判定される

#### Scenario: 後期の日付

- **WHEN** 判定対象の日付が 10〜12 月または 1〜3 月
- **THEN** 期は「後期」と判定される

### Requirement: 費目と期・区分から price を決定

システムは、費目と区分から請求に用いる `price_id` を決定 SHALL：
- **新規入部費**: 現在日付の期で自動決定（前期=¥4,000 の price / 後期=¥2,000 の price）。
- **継続（部費）標準**: ¥4,000 の price。
- **継続（部費）特別**: ¥2,000 の price。

各 `price_id` は環境変数で与えられる MUST。ドメインは金額の数値ではなく `price_id` を選ぶ（Product 単体では金額が一意に決まらないため、design.md の決定に従う）。選択した `price_id` が未設定（空）の場合は、Stripe 呼び出しに進まず設定エラーとする SHALL。

#### Scenario: 新規・前期は前期 price

- **WHEN** 費目が新規入部費で、現在が前期
- **THEN** 前期の `price_id`（¥4,000）が選択される

#### Scenario: 新規・後期は後期 price

- **WHEN** 費目が新規入部費で、現在が後期
- **THEN** 後期の `price_id`（¥2,000）が選択される

#### Scenario: 継続標準は標準 price

- **WHEN** 費目が継続（部費）で標準
- **THEN** 継続標準の `price_id`（¥4,000）が選択される

#### Scenario: price_id 未設定は設定エラー

- **WHEN** 選択対象の `price_id` が環境変数で未設定（空）
- **THEN** Stripe 呼び出しに進まず、設定エラーを返す

### Requirement: 発行の認可（標準は本人、特別は管理者）

システムは、請求書発行を次のように認可 SHALL：
- 標準系（新規入部費の前期/後期、継続標準 ¥4,000）は**ログイン利用者が自分の分のみ**発行できる。利用者は提出メールから導出した `mail_hash` がセッションの `mail_hash` と一致する場合に限り発行可能 MUST。
- 特別 ¥2,000（継続特別）は**会計（管理者）のみ**が対象者を指定して発行できる SHALL。利用者は特別請求書を発行しては SHALL NOT。管理者が未連携の対象者にメールを指定して Customer を作成する場合、そのメールから導出した `mail_hash` が対象者の `mail_hash` と一致することを検証 MUST。

#### Scenario: 利用者は自分の標準請求書を発行できる

- **WHEN** ログイン利用者が、自分のメール（`mail_hash` がセッションと一致）で標準請求書を要求する
- **THEN** 発行が許可される

#### Scenario: 利用者は他人の分を発行できない

- **WHEN** ログイン利用者が、セッションの `mail_hash` と一致しないメールで請求書を要求する
- **THEN** 発行は拒否される

#### Scenario: 利用者は特別請求書を発行できない

- **WHEN** ログイン利用者（非管理者）が特別 ¥2,000 の請求書を要求する
- **THEN** 発行は拒否される

#### Scenario: 管理者は特別請求書を発行できる

- **WHEN** 会計（管理者）が対象者を指定して特別 ¥2,000 の請求書を要求する
- **THEN** 対象者の Customer に対して発行が許可される

#### Scenario: 管理者が指定したメールが対象者と不一致なら拒否

- **WHEN** 会計が、Customer 未連携の対象者に対し、対象者の `mail_hash` と一致しないメールを指定して発行を要求する
- **THEN** 発行は拒否される

### Requirement: 請求書の作成・確定・送付

システムは、対象 Customer に対し Invoice ＋ InvoiceItem（選択した Price）を作成し、finalize して send まで行う SHALL。送付後、利用者は Stripe の支払いページで支払える MUST。請求書はドメイン非依存のアダプタ越しに作成する。短時間の二重 submit を防ぐため、決定的な冪等キーを Invoice 作成に付与 SHALL。作成途中で失敗した場合は、できる範囲で未確定の Invoice を後始末（void/削除）してエラーを返す MUST。

#### Scenario: 発行で支払いページに到達できる

- **WHEN** 認可された請求書発行が要求される
- **THEN** Customer に Invoice（Price 指定）が作成・finalize・send され、支払いページの案内（請求書メール／URL）が利用可能になる

#### Scenario: 連打しても重複請求書を作らない（冪等ウィンドウ内）

- **WHEN** 同一条件の発行要求が短時間に複数回届く
- **THEN** 冪等キーにより Stripe 側で重複が抑止され、同一の Invoice が返る

### Requirement: 支払い時の traQ ID 連結

請求書発行時、セッションが **traQ 認証（traqId）と利用者（userId）の双方**を持つ場合、システムは当該本人行の `users.traq_id` を保存（未設定時）し、Stripe Customer の `metadata` にも traQ ID を入れる SHALL。参照キーは引き続き `mail_hash` / `stripe_customer_id` であり、traQ ID は連結・ログ用に留める。`users.traq_id` が既に設定済みなら上書きしては SHALL NOT。traQ 未認証（traqId 無し）の発行では連結しない。連結が競合（その traq_id が他の本人に属する）した場合は、その traq_id を当該 Customer の metadata に書いては SHALL NOT。

#### Scenario: traQ 認証済みの支払いで連結される

- **WHEN** traQ 認証済みかつ user 解決済みのセッションで標準請求書を発行する
- **THEN** その本人行の `users.traq_id` が（未設定なら）保存され、Customer metadata にも traQ ID が入る

#### Scenario: 既に連結済みなら維持

- **WHEN** 既に `users.traq_id` を持つ本人が再度発行する
- **THEN** 既存の `traq_id` は上書きされない

#### Scenario: traQ 未認証では連結しない

- **WHEN** isct のみ（traQ 未認証）のセッションで発行する
- **THEN** `users.traq_id` は設定されない（発行自体は従来どおり可能）

#### Scenario: 競合 traq_id は metadata に書かない

- **WHEN** 連結が競合（その traq_id が他の本人に属する）する
- **THEN** その traq_id は Customer metadata に書かれず、発行自体は継続する
