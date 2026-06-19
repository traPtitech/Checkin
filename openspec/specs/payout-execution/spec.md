# payout-execution

## Purpose

Jomon で承認済みの振込依頼を取り込み、[[connect-onboarding]] で整えた connected account を使って Stripe で送金し、結果を Jomon に書き戻す。責任分界（design.md §5.3）: 承認・申請は Jomon、Checkin は実行のみ。連携は pull。Jomon は v1/v2 両対応＋stub 先行。お金が外に出るため、冪等・原子的クレーム・厳格バリデーションで二重送金と誤送金を防ぐ。

## Requirements

### Requirement: Jomon アダプタ（pull・v1/v2・stub）

システムは、承認済み振込依頼の取得と結果の書き戻しを `JomonClient` アダプタ越しに行う SHALL。実装は環境設定で `stub` / `v1` / `v2` を選択でき、ドメインは具体実装に依存しては SHALL NOT。Checkin→Jomon の認証は Bearer サービストークン（env、片方向）とする MUST。連携は pull とする。

#### Scenario: ドライバを切り替えられる

- **WHEN** `JOMON_API_VERSION` を `stub` / `v1` / `v2` のいずれかに設定する
- **THEN** 対応する `JomonClient` 実装が使われ、ドメインコードは変更不要

#### Scenario: 取得と書き戻しの両操作を持つ

- **WHEN** 払い戻しフローが Jomon と連携する
- **THEN** 「承認済み振込依頼の取得」と「結果（送金済み/失敗）の書き戻し」が `JomonClient` 経由で行える

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

### Requirement: 本人特定（対応表 mail_hash）と userId 不変

システムは、各振込依頼の受取人を対応表（`mail_hash`）で特定 SHALL。特定できない依頼は送金へ進めず要対応として記録する MUST。一度 `user_id` が確定した payout は、後続の取込で別人に解決されても**再リンクしては SHALL NOT**（要対応として扱う。誤送金防止）。

#### Scenario: 特定できたら処理を進める

- **WHEN** 振込依頼の受取人が `mail_hash` で `users` 行に解決でき、まだ user 未設定
- **THEN** `user_id` を設定し、onboarding 判定／送金へ進む

#### Scenario: 特定できなければ送金しない

- **WHEN** 受取人を `mail_hash` で特定できない
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

### Requirement: 結果を Jomon に書き戻す（再試行可能・再送金しない）

システムは、送金結果（送金済み / 失敗）を `JomonClient` を通じて Jomon に書き戻す SHALL。書き戻し成否を記録（例: `jomon_written_back_at`）し、送金成功済みだが書き戻し未了の payout は、再実行時に**書き戻しのみ再試行**して送金は再実行しては SHALL NOT。

#### Scenario: 送金済みを書き戻す

- **WHEN** payout が `paid` になる
- **THEN** Jomon に「送金済み」が書き戻され、書き戻し済みが記録される

#### Scenario: 書き戻し失敗は再試行され、再送金はしない

- **WHEN** 送金は成功したが Jomon 書き戻しが失敗し、後で再実行する
- **THEN** 送金は再実行されず、書き戻しのみ再試行される

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
