# payout-execution

## Purpose

Jomon で承認済みの振込依頼を取り込み、[[connect-onboarding]] で整えた connected account を使って Stripe で送金し、結果を Jomon に書き戻す。責任分界（design.md §5.3）: 承認・申請は Jomon、Checkin は実行のみ。連携は pull。Jomon は v1/v2 両対応＋stub 先行。お金が外に出るため、冪等・原子的クレーム・厳格バリデーションで二重送金と誤送金を防ぐ。

## Requirements

### Requirement: Jomon アダプタ（pull・v1/v2・stub）

システムは、承認済み振込依頼の取得と結果の書き戻しを `JomonClient` アダプタ越しに行う SHALL。実装は環境設定で `stub` / `v1` / `v2` を選択でき、ドメインは具体実装に依存しては SHALL NOT。連携は pull とする。実 Jomon API に従い:
- 承認済みの取得は **`GET /api/applications`**（v1 は `current_state=accepted`、v2 は `status=approved`）。
- payee は **traQ ID**。v1 は `repaid_to_user.trap_id`（文字列）、v2 は `ApplicationTarget.target`（User UUID）を `GET /api/users` の `User.name` で traQ ユーザー名に解決 MUST。
- 通貨は持たないため `jpy` 固定とする。
- 結果の書き戻しは v1 が `PUT /api/applications/{id}/states/repaid/{trapId}`。**v2 は per-payee の書き戻し API が無い**ため、未対応として明示的に失敗（警告ログ）し、Jomon v2 側の追加を待つ MUST（payout のローカル `paid` 状態は保持する）。
- Checkin→Jomon は Bearer サービストークン（env、片方向）で送る前提とする。ただし現状の Jomon に Bearer 受け口は無く、実接続は Jomon 側の追加が前提（要調整）。

#### Scenario: ドライバを切り替えられる

- **WHEN** `JOMON_API_VERSION` を `stub` / `v1` / `v2` のいずれかに設定する
- **THEN** 対応する `JomonClient` 実装が使われ、ドメインコードは変更不要

#### Scenario: 承認済みを /api/applications から取得

- **WHEN** v1/v2 で承認済み振込依頼を取得する
- **THEN** `GET /api/applications`（v1 `current_state=accepted` / v2 `status=approved`）から取得し、payee=traQ ID・amount・通貨 jpy を持つ依頼に正規化される

#### Scenario: v2 の書き戻しは未対応として扱う

- **WHEN** v2 ドライバで結果を書き戻そうとする
- **THEN** 未対応として明示的に失敗（警告ログ）し、payout のローカル `paid` 状態は保持される（Jomon v2 側追加待ち）

### Requirement: Jomon レスポンスの厳格バリデーション（fail-safe）

システムは、Jomon から取得した振込依頼を厳格に検証 SHALL：受取人識別子が非空、`jomon_ref` が非空、`amount` が正の整数、通貨が存在すること。欠落・不正・想定外の形は既定値で埋めず**エラーとして拒否** MUST（誤った人への送金や 0 円送金を黙って作らない）。

#### Scenario: 不正な形は拒否

- **WHEN** 受取人識別子・`jomon_ref`・`amount` のいずれかが欠落/不正な依頼が返る
- **THEN** 既定値で補わずエラーとして扱い、その依頼は送金へ進めない

### Requirement: 取込は jomon_ref で冪等

システムは、取り込んだ振込依頼を `payouts` に記録し、`jomon_ref` を unique キーとして冪等に upsert SHALL。同一依頼を複数回取り込んでも重複行や二重送金を起こしては SHALL NOT。

#### Scenario: 同一依頼の再取込は重複しない

- **WHEN** 同じ `jomon_ref` の依頼を 2 回取り込む
- **THEN** `payouts` 行は 1 つのままで、状態は引き継がれる

### Requirement: 本人特定（traQ ID）と userId 不変

システムは、各振込依頼の受取人を **traQ ID（`users.traq_id`）** で特定 SHALL。Jomon は受取人を traQ ID で渡すため、`getUserByTraqId` で本人行に解決する（`users.traq_id` は認証済み traQ ログインで連結済みのもの）。特定できない（未連結の traQ ID）依頼は送金へ進めず、要対応として記録する MUST。一度 `user_id` が確定した payout は、後続の取込で別人に解決されても**再リンクしては SHALL NOT**（要対応として扱う。誤送金防止）。

#### Scenario: 連結済み traQ ID は処理を進める

- **WHEN** 振込依頼の payee traQ ID が `users.traq_id` で本人行に解決でき、まだ user 未設定
- **THEN** `user_id` を設定し、onboarding 判定／送金へ進む

#### Scenario: 未連結 traQ ID は送金しない

- **WHEN** payee traQ ID がどの本人行にも連結されていない（`users.traq_id` 無し）
- **THEN** 送金は行わず、要対応として記録される

#### Scenario: 確定済み userId は変えない

- **WHEN** 既に `user_id` のある payout が、後続取込で別人に解決される
- **THEN** 再リンクせず要対応として扱い、送金しない

### Requirement: onboarding 未完なら onboarding へ誘導

システムは、受取人の `payout_onboarding_status` が `done` でない場合、connected account を get-or-create し onboarding リンクを発行したうえで、当該 payout を `onboarding_waiting` とする SHALL。`done` になるまで送金しては SHALL NOT。

#### Scenario: 未完は待機にする

- **WHEN** 受取人の onboarding が未完（`done` でない）で払い戻しが必要
- **THEN** onboarding リンクが発行され、payout は `onboarding_waiting` になる（送金はしない）

#### Scenario: 完了後に再開できる

- **WHEN** 受取人の onboarding が `done` になった後で再実行する
- **THEN** `onboarding_waiting` の payout が送金へ進む

### Requirement: 送金前の原子的クレーム（二重送金防止）

システムは、Stripe 送金の前に payout を原子的にクレーム SHALL：`status` を `processing` へ条件付き更新（`status IN ('pending','onboarding_waiting','failed')` のときのみ成功）し、クレームに失敗した（他の実行が先行した）場合は再読込して短絡し、**送金しない** MUST。これにより同一 `jomon_ref` への同時実行で二重に送金されては SHALL NOT。Stripe 冪等キー（`payout:${jomonRef}`）を併用する。

#### Scenario: 同時実行は一方だけが送金する

- **WHEN** 同一 `jomon_ref` に対し処理が同時並行で走る
- **THEN** クレームに成功した 1 つだけが送金し、他方は短絡して送金しない

### Requirement: Stripe での送金実行と結果確定

システムは、`done` の受取人の connected account に対し Stripe で送金（transfer）を実行 SHALL。成功時は payout を `paid` にし `stripe_transfer_id` を保存、失敗時は `failed` にする MUST。確定済みの `paid` を上書きして送金し直しては SHALL NOT。

#### Scenario: 送金成功

- **WHEN** クレーム済みの payout へ送金を実行し成功する
- **THEN** payout は `paid` になり `stripe_transfer_id` が保存される

#### Scenario: 送金失敗

- **WHEN** 送金実行が失敗する
- **THEN** payout は `failed` になり、二重送金は起きない

### Requirement: 手動振込での paid 確定（Stripe 送金を行わない）

システムは、Stripe Connect のオンボーディングを完了できない受取人に会計が銀行から手で振り込んだ場合に、当該 payout を Stripe transfer を発行せずに `paid` へ確定する手動確定パスを提供 SHALL。対象は `pending` / `onboarding_waiting` / `failed` の payout のみとし、`paid` / `processing` は対象外として拒否 MUST（確定済みや実行中の上書きをしない）。

確定は原子的に行う SHALL：単一の条件付き UPDATE で `status` を `paid` にし、同時に `payout_method` を `manual_bank` に、`manual_paid_at`・`manual_paid_note`・`manual_paid_by`（実行した会計のユーザー）を記録する。条件は `status IN ('pending','onboarding_waiting','failed')` を満たすときのみ成功とし、満たさない（既に `paid` / `processing`）場合は更新を行わず短絡 MUST。これにより Stripe 送金フロー（`processing` クレーム）との競合や二重確定で二重に支払われては SHALL NOT。手動確定では `stripe_transfer_id` を設定しては SHALL NOT。

手動確定の対象は受取人（`user_id`）が解決済みである必要は無い MUST NOT 制約とはしないが、本人特定の不変条件（確定済み `user_id` を別人に再リンクしない）は維持する SHALL。

#### Scenario: 未払いの payout を手動振込済みにできる

- **WHEN** 会計が `pending` / `onboarding_waiting` / `failed` のいずれかの payout を、参照メモ付きで「手動振込済み」にする
- **THEN** Stripe transfer を発行せず payout が `paid` になり、`payout_method=manual_bank`・`manual_paid_at`・`manual_paid_note`・`manual_paid_by` が記録される（`stripe_transfer_id` は空のまま）

#### Scenario: paid / processing は手動確定できない

- **WHEN** 会計が `paid` または `processing` の payout を手動振込済みにしようとする
- **THEN** 確定は拒否され、状態は変化せず、二重支払いは起きない

#### Scenario: Stripe 送金との競合で二重に支払わない

- **WHEN** 同一 `jomon_ref` に対し、手動確定と Stripe 送金フローのクレームが同時並行で走る
- **THEN** 原子的更新により一方だけが `paid` を確定し、他方は短絡して支払い（送金）を行わない

### Requirement: 結果を Jomon に書き戻す（再試行可能・再送金しない）

システムは、確定結果（Stripe 送金で `paid` / 手動振込で `paid` / 失敗）を `JomonClient` を通じて Jomon に書き戻す SHALL。書き戻し成否を記録（`jomon_written_back_at`）し、`paid` 済みだが書き戻し未了の payout は、再実行時に**書き戻しのみ再試行**して送金や手動確定を再実行しては SHALL NOT。手動振込で `paid` になった payout は `stripe_transfer_id` を持たないため、書き戻しは `stripe_transfer_id` の存在を前提とせず、手動振込である旨（および `manual_paid_note`）で代替して settled を書き戻す SHALL。v1 は `PUT .../states/repaid/{trapId}` を用いる。**v2 は書き戻し API が無いため未対応として失敗（警告ログ）**し、`jomon_written_back_at` は未設定のまま将来の Jomon 追加に備える（`paid` は確定済みとして保持）。

#### Scenario: v1 は送金済みを書き戻す

- **WHEN** v1 で payout が（Stripe 送金で）`paid` になる
- **THEN** `PUT .../states/repaid/{trapId}` で「送金済み（repaid_at）」が書き戻され、書き戻し済みが記録される

#### Scenario: v1 は手動振込済みを書き戻す

- **WHEN** v1 で payout が手動振込で `paid` になる（`stripe_transfer_id` 無し）
- **THEN** `stripe_transfer_id` を要求せず、`PUT .../states/repaid/{trapId}` で settled（repaid_at）が書き戻され、書き戻し済みが記録される

#### Scenario: 書き戻し失敗は再試行され、再送金はしない

- **WHEN** 確定（送金または手動振込）は成功したが Jomon 書き戻しが失敗（v2 未対応含む）し、後で再実行する
- **THEN** 送金も手動確定も再実行されず、書き戻しのみ再試行される（v2 は対応追加まで失敗し続けるが二重支払いは起きない）

### Requirement: バッチの個別分離と failed の再試行ポリシー

システムは、複数依頼の一括処理で 1 件の失敗が他の処理を止めないよう、各依頼を個別に分離（try/catch）し、エラーを集計して継続する SHALL。一括処理（取込）は `failed` の payout を**自動再試行しない** MUST。`failed` の再試行は会計による単一実行でのみ行う SHALL。

#### Scenario: 1 件の失敗で全体が止まらない

- **WHEN** 一括処理中に 1 件がエラーになる
- **THEN** そのエラーは集計され、残りの依頼は処理が継続する

#### Scenario: 一括は failed を自動再試行しない

- **WHEN** 一括処理が `failed` の payout を含む
- **THEN** その `failed` は自動再送金されず、スキップ集計される（再試行は会計の単一実行のみ）

### Requirement: 払い戻し操作は会計のみ

取込・実行・一覧/状態確認は会計（管理者）のみがアクセス可能 SHALL。認可チェックは入力検証より先に実行され、状態変更を伴う操作は CSRF 検証を行う MUST。

#### Scenario: 会計は実行できる

- **WHEN** 会計セッションで取込・実行・一覧を要求する
- **THEN** 操作が許可される

#### Scenario: 非会計は拒否

- **WHEN** 利用者または未ログインで払い戻し操作を要求する
- **THEN** 認可エラーで拒否される

### Requirement: v1 の払い戻し金額と複数受取人の扱い

v1 は払い戻し金額を**申請単位**（`current_detail.amount`）でしか持たず、受取人（`repayment_logs[]`）単位の金額を持たない。システムは v1 ドライバで金額を `current_detail.amount` から取得する SHALL（repayment_log に `amount` を要求しては SHALL NOT）。

送金へ進めるかは申請の**総受取人数**（`repayment_logs` の要素数）で判定する MUST：
- 受取人が **1 人だけ**の申請は、その人の払い戻し額が申請額に等しいので、未払いなら `current_detail.amount` で送金フローへ進める MUST。
- 受取人が **2 人以上**の申請は、`current_detail.amount` が申請総額であり個人へ按分する根拠が無いため、**たとえ未払いが 1 人でも**自動送金しては SHALL NOT（残り 1 人へ総額を送ると過払いになる）。`payouts` 行を作らず、`processApproved` の集計で needs-review に数え、対象 application id を返却して会計の UI に**警告として明示**する MUST。
- 全受取人が支払い済み（未払い 0 人）の申請は送金対象にしない。

この判定は手動の単一実行（`payouts.execute`）でも同様に適用し、複数受取人の申請を送金へ進めては SHALL NOT。

#### Scenario: 受取人が 1 人の申請は申請額で送金へ進む

- **WHEN** 承認済み申請の受取人が 1 人で未払いである
- **THEN** その受取人を payee とし、`current_detail.amount` を払い戻し額として送金フロー（本人特定・onboarding・原子的クレーム・送金）へ進む

#### Scenario: 受取人が複数の申請は自動送金せず UI 警告（一部支払い済みでも）

- **WHEN** 承認済み申請の受取人が 2 人以上である（未払いが 1 人だけに減っていても含む）
- **THEN** 自動送金せず（`payouts` 行も作らず）、needs-review として集計し、対象 application id を会計 UI に警告として表示する

#### Scenario: v1 の金額は申請単位から取得する

- **WHEN** v1 ドライバが承認済み申請の詳細を取得する
- **THEN** 払い戻し額は `current_detail.amount` から取得され、repayment_log 側の金額には依存しない
