# Checkin — 挙動確認シナリオ一覧（入部 / 継続 / 特別対応 / 払い戻し）

> Playwright を中心とした実挙動確認のための **シナリオ網羅リスト**。
> 仕様（`openspec/specs/`）と実装（`packages/api/src/`、`apps/web/`）を突き合わせて洗い出したもの。
> 各シナリオは「どの経路で・何を前提に・何を期待するか・どう検証するか」をセットで記す。
> 作成: 2026-06-24 / ブランチ: `claude/checkin-auth-collection`

---

## 0. 凡例・共通前提

### 0.1 セッション種別（`/dev/login` で偽造）

ローカルは traQ OAuth / isct メール確認を経ずに `GET /dev/login` でセッションを発行できる（`import.meta.dev` ＋ `CHECKIN_DEV_LOGIN=1` の二重ガードで本番無効）。

| 種別 | URL | セッション内容 | 主な用途 |
|---|---|---|---|
| 未ログイン | （cookie 無し） | — | `/membership` 振り分け・認可拒否 |
| 会員のみ | `/dev/login?as=member` | `traqId=devmember, !hasUser` | 「会員だが未連結」分岐 |
| 利用者あり | `/dev/login?as=user&email=<isct>` | `hasUser`（mail_hash 連結） | **入部・継続の発行** |
| 会員＋利用者 | `/dev/login?as=both&email=<isct>` | `traqId＋hasUser` | traQ ID 連結（払い戻しの本人解決前提） |
| 会計 | `/dev/login?as=admin` | `isAdmin` | **特別対応・払い戻し・一覧** |

> 同じ `email` は同じ person 行に落ちる（冪等 get-or-create）。**新規 customer/台帳が欲しいテストは毎回 fresh な `?email=` を使う**（Stripe 冪等ウィンドウ汚染回避、HANDOVER §8）。

### 0.2 CSRF / 状態変更

状態変更（発行・取込・実行）は `assertCsrf()` 必須。Playwright（ブラウザ）は `/csrf` cookie 由来の `x-csrf-token` を `plugins/orpc.ts` が自動付与するので UI 操作なら透過。**curl で叩く場合は `/csrf` 取得 → cookie ＋ `x-csrf-token` ヘッダ**が要る。headless+http は Secure な CSRF cookie を保持しにくいので mutation は curl 併用が安全（HANDOVER §8）。

### 0.3 環境依存（検証時に意識する点）

- **期判定は実時刻依存**（`computeTerm(now)`）。今日 = 2026-06-24 は**前期**（活動年度 2026）。**後期系シナリオは「後期日付」を作れないと UI では再現不可** → 単体テスト（`*.test.ts`）or 時計固定が必要。該当箇所に「⏱ 時計依存」を付す。
- **Stripe**: test キー＋4 Price＋`stripe listen`（`/webhook/invoice-paid`・`/webhook/account-updated`）配線済み（HANDOVER §10）。
- **Jomon**: v1 ローカル（`:1323`）で closed-loop 実績あり。`.env` の `JOMON_API_VERSION` で `stub`/`v1`/`v2` 切替。
- **入金確定（`invoice.paid`）と着金は非同期**。台帳 `paid` 化・会計通知はこの webhook 経由。

### 0.4 検証手段の表記

`UI`=Playwright ブラウザ操作 / `API`=oRPC を curl 直叩き / `WH`=Stripe webhook（`stripe trigger` or 実支払い）/ `JOMON`=Jomon 取込 / `UT`=単体テスト（vitest）。

---

## 1. 入部（新規入部・再入部）— `feeType: 'new'`

エントリ: `/membership`（未ログイン → `新規入部`/`再入部` 選択）。発行 API: `membership.issueInvoice`（`userProc`＝利用者本人のみ）。
価格/カバレッジ: **前期 → ¥4,000 通期（前期＋後期）/ 後期 → ¥2,000 後期のみ**、活動年度＝**現年度**。

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 入-01 | 正常 | 未ログイン | `/membership` で `新規入部` を選ぶ | `/verify-email?redirect=%2Fmembership%3Ftype%3Dnew`（redirect 先に `?type=new` を保持し区分を事前選択）へ誘導 | UI |
| 入-02 | 正常 | 未ログイン | `/membership` で `再入部` を選ぶ | `/verify-email?redirect=%2Fmembership%3Ftype%3Drejoin`（`rejoin`→`feeType:new`）へ誘導 | UI |
| 入-03 | 正常 | 未ログイン | `/membership` で `現役` を選ぶ | `/login?redirect=/membership`（traQ）へ誘導 | UI |
| 入-04 | 正常（前期） | 利用者あり（fresh email）| `/membership` でメール・氏名・`新規入部`→発行 | ¥4,000 通期 invoice が finalize、`hostedInvoiceUrl` 導線表示。台帳に前期＋後期2スロット `open` | UI＋Stripe確認 |
| 入-05 | 正常（後期）⏱ | 利用者あり（後期日付）| 後期に `新規入部` 発行 | ¥2,000 後期のみ invoice、台帳に後期1スロット `open` | UT（時計固定） |
| 入-06 | 認可 | 利用者あり | フォームに**自分以外の**メールを入れて発行 | `FORBIDDEN`「他人の分は発行できない」（mail_hash 不一致） | API |
| 入-07 | 認可 | 会員のみ（`member && !hasUser`）| `/membership` を開く | 発行フォームは出ず、連結を促す案内と「メールアドレスを確認する」ボタン（`/verify-email?redirect=/membership`）を表示（**自動遷移はしない**・押下で遷移） | UI |
| 入-08 | 認可 | 未ログイン | `membership.issueInvoice` を直接叩く | 認可エラー（`userProc` が入力検証より前に拒否） | API |
| 入-09 | 冪等（重複）| 入-04 済み（**未払いのまま**）| 同条件で再発行 | 新 invoice を作らず**既存 `hostedInvoiceUrl` を返す**（台帳 open 再利用） | UI/API |
| 入-10 | 冪等（重複）| 入-04 が**支払い済み**| 同条件で再発行 | `CONFLICT`「対象期間は既に支払い済み」 | API＋WH |
| 入-11 | 境界（重複）| 後期のみ `open`／`paid` がある人 | 前期入部（通期）を発行 | `CONFLICT`「期間が重複」（通期×後期の重なり拒否） | UT/API |
| 入-12 | 連打 | 利用者あり | 同条件発行をほぼ同時に複数回 | 台帳一意制約で**単一 invoice に収束**、ガード無し invoice が残らない | UT |
| 入-13 | 異常（設定）| `PRICE_*` 未設定 | 発行 | Stripe 呼び出し前に設定エラー、UI にエラー表示・二重送信させない | API |
| 入-14 | 連結 | `as=both`（traQ＋user）| 入部発行 | `users.traq_id` が未設定なら保存、Customer metadata に traQ ID | API＋DB |
| 入-15 | 連結 | 既に `traq_id` 持ち | 再発行 | 既存 `traq_id` を上書きしない | DB |
| 入-16 | 連結 | isct のみ（traQ 未認証）| 発行 | `traq_id` 設定されない（発行自体は成功） | API＋DB |
| 入-17 | 連結（競合）| session traq_id が他人に属する | 発行 | その traq_id を Customer metadata に書かない・発行は継続 | UT |
| 入-18 | 異常（途中失敗）| finalize を失敗させる | 発行 | draft を void・予約スロット解放・エラー返却（支払い可能 invoice を残さない） | UT |
| 入-19 | 正常（Customer解決）| ① 未連携 ② DB に customer_id 連携済み ③ DB 無いが Stripe に同メール Customer あり | 各状態で発行 | [[stripe-customer]] の3分岐: ①新規作成して保存 ②DB の customer_id 再利用 ③Stripe 検索で既存採用（重複作成しない） | API＋Stripe |

---

## 2. 継続 — `feeType: 'continuation'`

エントリ: `/membership`（`現役` → traQ ログイン → `hasUser` で発行）。発行 API: `membership.issueInvoice`（同上）。
価格/カバレッジ: **常に ¥4,000 通期**、活動年度＝**翌年度**（`base+1`、会計が後期に開始する更新を想定。今年度払い済みとスロット衝突させない）。

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 継-01 | 正常 | `as=both`（現役相当）| `/membership` で `現役`→メール・氏名で発行 | `feeType:continuation`・¥4,000 通期 invoice、`hostedInvoiceUrl` | UI |
| 継-02 | 境界（年度）| 継-01 | 発行後の台帳行を確認 | 占有スロットの `activity_year` が**翌年度**（発行時点＋1） | DB |
| 継-03 | 両立 | 同一人が**今年度**入部済み（paid）| 翌年度の継続を発行 | 年度キーが違うので衝突せず発行できる | API＋DB |
| 継-04 | 冪等（重複）| 継続を**未払いのまま**再発行 | 同条件で再発行 | 既存 `hostedInvoiceUrl` を返す | UI/API |
| 継-05 | 冪等（重複）| 継続が**翌年度で支払い済み**| 同条件再発行 | `CONFLICT`「既に支払い済み」 | API＋WH |
| 継-06 | 認可 | 利用者あり | 他人メールで継続発行 | `FORBIDDEN`（mail_hash 不一致） | API |
| 継-07 | UI 対応 | — | `区分=現役` を選ぶ | `feeType:'continuation'` で発行されること（新規/再入部は `'new'`） | UI |

---

## 3. 特別対応（会計発行・常に ¥2,000・半期1つ）

エントリ: `/special-invoice`（会計ナビ「特別発行」）。API: `membership.issueSpecialInvoiceByEmail`（メール指定・初見ユーザーも可）／`issueSpecialInvoice`（`userId` 指定・従来）。両方 `adminProc`。
価格/カバレッジ: **¥2,000・`coverage` で `zenki`/`kouki` を会計が明示指定（通期不可）**、`activityYear` 任意（後期に集める継続特別は翌年度を渡す）。

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 特-01 | 正常（前期）| 会計 | `/special-invoice` でメール・`前期(zenki)` 指定→発行 | ¥2,000・前期1スロット `open`、hosted invoice URL を会計に表示（本人へ転送用） | UI |
| 特-02 | 正常（後期追加）| 前期のみ特別を支払い済みの人 | 同人に `後期(kouki)` を発行 | 後期スロットは空きなので新規予約でき、前期・後期が別発行で両立 | API＋DB |
| 特-03 | 正常（初見）| 会計・対象は**未ログイン/初見**| メール指定で発行 | mail_hash で person を get-or-create、Customer 作成、発行成功（事前ログイン不要） | UI |
| 特-04 | 認可 | 利用者（非会計）| `issueSpecialInvoice*` を叩く | 認可エラー（`adminProc`）。利用者 UI に特別の導線は出ない | API＋UI |
| 特-05 | 認可 | 会計・`userId` 指定で**メール不一致**（未連携対象）| メールを対象者の mail_hash と違う値で発行 | 発行拒否（指定メール＝対象者の検証に失敗） | API |
| 特-06 | 異常（ドメイン）| 会計 | 許可ドメイン外メールで `ByEmail` 発行 | ドメインガードで拒否（junk person を作らない） | API |
| 特-07 | 境界（年度）| 会計 | `activityYear` を翌年度で指定発行 | 指定年度のスロットを占有（既定は現年度） | DB |
| 特-08 | 冪等（重複）| 同半期が既に `paid` | 同半期を再発行 | `CONFLICT`「既に支払い済み」 | API |
| 特-09 | 冪等（重複）| 同半期が `open` 未払い | 同半期を再発行 | 既存 `hostedInvoiceUrl` を返す | API |
| 特-10 | 境界（通期不可）| 会計 | `coverage` に通期相当を渡そうとする | スキーマ上 `zenki`/`kouki` のみ（通期は選べない） | API/UT |
| 特-11 | 入金合流 | 特-01 を本人が支払い | `invoice.paid` 受信 | 該当半期スロットが `paid`、会計へ通知（標準と同経路） | WH |

---

## 4. 払い戻し（Jomon 承認分 → Stripe 送金 → 書き戻し）

エントリ: `/payouts`（会計）。API: `payouts.processApproved`（取込・前進）/`list`/`execute`（行ごと前進・failed 再試行）/`createOnboardingLink`/`onboardingStatus`。全 `adminProc`。
フロー: Jomon `accepted` 取込 → 厳格バリデーション → `jomon_ref` 冪等 upsert → traQ ID で本人解決 → onboarding ゲート → 原子的クレーム → Stripe transfer（冪等キー `payout:${ref}`）→ `paid`／`failed` → Jomon 書き戻し。

### 4.1 取込・本人特定・バリデーション

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 払-01 | 正常 | 会計・Jomon に承認済み（単一 payee・本人 traQ 連結済み・onboarding done）| `/payouts` で「Jomon 取込」 | `ingested` 件数サマリ表示、本人解決→送金フローへ進み一覧更新 | UI＋JOMON |
| 払-02 | 冪等 | 払-01 と同じ依頼 | 取込を再実行 | `payouts` 行は1つのまま・状態継承（`jomon_ref` unique 冪等 upsert） | API＋DB |
| 払-03 | 異常（バリデーション）| payee/`jomon_ref`/`amount` のいずれか欠落・不正 | 取込 | 既定値で埋めず**拒否**、その依頼は送金へ進めない（0円・誤送金防止） | UT/JOMON |
| 払-04 | 要対応 | payee traQ ID が**未連結**（`users.traq_id` 無し）| 取込 | 送金せず要対応として記録（onboarding/送金へ進めない） | API＋DB |
| 払-05 | 要対応（誤送金防止）| 既に `user_id` 確定済みの payout が後続取込で別人に解決 | 取込 | **再リンクしない**・送金しない・要対応 | UT |
| 払-29 | 設定（driver切替）| `JOMON_API_VERSION` を `stub`/`v1`/`v2` に設定 | 取込 | 対応する `JomonClient`（`createJomonClient` 分岐）が使われ、ドメインコードは不変 | API/UT |

### 4.2 onboarding ゲート（[[connect-onboarding]]）

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 払-06 | 正常（未完）| 受取人 `payout_onboarding_status != done` | 取込/execute | connected account を get-or-create、onboarding リンク発行、payout は `onboarding_waiting`（**送金しない**） | UI＋API |
| 払-07 | 正常（再利用）| `stripe_connected_account_id` 設定済み | onboarding 要求 | 新規作成せず既存 account を使う | UT |
| 払-30 | 競合 | 同一受取人に onboarding 発行が同時並行 | 並行 `createOnboardingLink` | 永続化される connected account は1つだけ・敗者が作った余分な account を後始末（CAS） | UT |
| 払-31 | 状態機械（初期）| onboarding 未開始の受取人 | `onboardingStatus` | 状態は `none`（初期）・account 無し | API |
| 払-08 | 状態機械 | リンク発行 | `createOnboardingLink` | 状態 `none→requested`（done は後退しない） | API＋DB |
| 払-09 | WH 判定 | `account.updated`（`payouts_enabled=true`＋`currently_due` 空）受信 | webhook | 受取人 `requested→done` に遷移 | WH |
| 払-10 | WH 判定 | `account.updated`（払い出し不可）受信 | webhook | `done` にしない（`requested` 維持） | WH |
| 払-11 | WH 冪等 | 同一 event id 再送 | webhook | 二重処理しない | WH |
| 払-12 | WH 署名 | 署名欠落/不正の webhook | webhook | 4xx 拒否 | WH/API |
| 払-13 | 再開 | done 化後の `onboarding_waiting` payout | `execute` | 送金フローへ進む | UI＋API |
| 払-14 | UI | 会計・userId 解決済み行 | `/payouts` で onboarding 状態確認 | `onboardingStatus` で status と account 有無を表示 | UI |

### 4.3 送金（原子的クレーム・冪等・結果確定）

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 払-15 | 正常 | done・クレーム可能（`pending`/`onboarding_waiting`/`failed`）| `execute` | `processing` へ条件付き更新→Stripe transfer→`paid`＋`stripe_transfer_id` 保存 | UI＋Stripe |
| 払-16 | 冪等（二重送金防止）| 同一 `jomon_ref` を同時 execute | 並行実行 | クレーム成功した1つだけ送金、他方は短絡（送金しない） | UT |
| 払-17 | 冪等（再実行）| 既に `paid` | `execute` | `already_paid` で短絡・送金し直さない（balance 不変） | API＋Stripe |
| 払-18 | 異常 | transfer が失敗 | `execute` | `failed` に・二重送金しない | UT/API |
| 払-19 | 認可 | 利用者/未ログイン | `processApproved`/`execute`/`list` を叩く | 認可エラー（`adminProc`） | API |

### 4.4 複数受取人・v1 金額（誤送金/過払い防止）

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 払-20 | 正常（v1 金額）| v1・単一 payee・未払い | 取込/execute | 払い戻し額は申請単位 `current_detail.amount`（repayment_log の amount に依存しない） | JOMON |
| 払-21 | 要対応（複数）| `repayment_logs` が **2人以上**（未払い1人でも）| 取込 | `payouts` 行を作らず needs-review に集計、対象 application id を**会計 UI に警告表示**（自動送金しない） | UI＋JOMON |
| 払-22 | 対象外 | 全受取人が支払い済み（未払い0）| 取込 | 送金対象にしない | JOMON |
| 払-23 | 手動でも適用 | 複数受取人の申請 | `payouts.execute` | 単一実行でも送金へ進めない | API |

### 4.5 書き戻し・バッチ分離

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 払-24 | 正常（v1）| v1・送金 `paid` | 書き戻し | `PUT .../states/repaid/{trapId}` で repaid_at 書き戻し、`jomon_written_back_at` 記録 | JOMON |
| 払-25 | 再試行（送金しない）| 送金成功・書き戻し未了 | 再 execute | **書き戻しのみ再試行**・送金は再実行しない | API |
| 払-26 | v2 未対応 | `JOMON_API_VERSION=v2`・送金 paid | 書き戻し | 未対応として失敗（警告ログ）、`paid` は保持・`written_back_at` 未設定 | UT |
| 払-27 | バッチ分離 | 取込中に1件エラー | `processApproved` | エラーは集計され残りは継続（全体停止しない） | API |
| 払-28 | failed 自動再試行なし | `failed` を含む一括 | `processApproved` | `failed` は自動再送金せずスキップ集計（再試行は会計の単一 execute のみ） | API |

---

## 5. 横断シナリオ（4 機能の土台）

### 5.1 発行台帳・入金確定（[[issuance-ledger]] / [[payment-webhook]]）

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 横-01 | 正常（入金）| open invoice を本人が支払い | `invoice.paid` 受信 | 署名検証＋event 冪等→`charge_group` 全スロット `paid`・支払い時刻記録・会計通知 | WH |
| 横-02 | 冪等（再入金）| 既に `paid` | `invoice.paid` 再送 | `paid` のまま・二重副作用なし | WH |
| 横-03 | 解放（void）| open スロット占有の発行を void | void | スロット解放、同半期に再発行可能 | API/UT |
| 横-04 | 1半期1スロット | 前期占有済み | 同年度・前期を再占有 | 一意制約で拒否 | UT |
| 横-21 | 異常（署名）| 署名欠落/不正の `invoice.paid` | webhook 送信 | raw-body 署名検証に失敗し処理せず 4xx 拒否（通知も台帳確定もしない） | WH/API |
| 横-22 | 異常（通知失敗→再試行）| 未処理 event で `Notifier` が失敗 | webhook | event id を**記録せず**返す → Stripe 再送で再試行可能（at-least-once）。台帳確定とは独立 | UT/WH |
| 横-23 | 境界（台帳外）| 台帳にスロットを持たない invoice | `invoice.paid` 受信 | 台帳確定をスキップし受信は成功（200）として扱う（台帳導入前/台帳外発行の互換） | WH |

### 5.2 口座振込（[[membership-billing]] / bank-transfer）

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 横-05 | 正常 | 任意の発行（入部/継続/特別）| hosted invoice ページを開く | カードと口座振込（`customer_balance`/`jp_bank_transfer`）の両方を選べる | UI＋Stripe |
| 横-06 | 非同期着金 | 口座振込を選択 | 振込→着金 | 着金まで invoice は `open`、着金で `invoice.paid` 経路に合流（横-01 と同じ paid 確定・通知） | WH |

### 5.3 認証・本人連結の前段（[[email-verification]] / [[session]] / [[identity]]）

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 横-07 | 正常 | 未ログイン | `/verify-email` で isct メール送信 | 「確認メールを送信しました」、マジックリンク発行（単回・期限・ハッシュ保存）| UI |
| 横-08 | redirect 保持 | `/verify-email?redirect=/membership` | 確認 | リンクが redirect を保持し確認後に `/membership` へ戻る | UI |
| 横-09 | ドメイン外 | 許可外メール | 送信 | エラー表示・メール送られない | UI |
| 横-10 | 連結 | 確認リンク踏破 | `/verify-email/confirm` | セッションに userId 連結（`hasUser`）、`/membership` で発行可能に | UI |
| 横-18 | 認可（OAuth）| traQ OAuth コールバックの `state` 不一致 | `/login/callback` | セッション確立を拒否（CSRF/リプレイ対策、`admin-authorization`） | API |
| 横-19 | 認可（CSRF）| ログイン済み・CSRF トークン欠如/不一致 | 状態変更 API（発行/取込/execute）を叩く | `assertCsrf()` で拒否（double-submit 不一致） | API |
| 横-20 | 異常（トークン）| 期限切れ／使用済みのメール確認リンク | 確認リンク踏破 | 拒否（単回・期限・ハッシュ保存。再利用/期限切れを通さない） | API/UT |
| 横-26 | セッション無効化 | ログイン済み | `/logout` 後に同一 cookie で `auth.me` | 認証不可（サーバ側セッション無効化、`session` spec） | UI/API |

### 5.4 会計 UI 一覧（[[accountant-ui]] / [[payment-listing]]）

| ID | 種別 | 前提 | 操作 | 期待 | 検証 |
|---|---|---|---|---|---|
| 横-11 | 認可表示 | 未ログイン/会員のみ | `/payments`・`/payouts` を開く | 会計データ非表示・「要会計ログイン」案内、会計導線は admin のみ | UI |
| 横-12 | 請求書タブ | 会計 | `/payments` 請求書タブ | `listInvoices` 結果を表表示・各行に Dashboard リンク | UI |
| 横-13 | 決済セッションタブ | 会計 | タブ切替 | `listCheckoutSessions` 結果表示 | UI |
| 横-14 | フィルタ | 会計 | status を `paid` に変更 | `status:'paid'` で再取得・カーソルリセットで先頭から | UI |
| 横-15 | ページネーション | `hasMore=true` | 次ページ導線 | `startingAfter:nextCursor` で次ページ取得、末尾では導線非表示 | UI |
| 横-16 | 競合防止 | 連続フィルタ変更 | 高速に切替 | request-seq で古い応答を破棄（順序逆転で誤表示しない） | UI |
| 横-17 | ⚠️ USelect 空文字 | 会計 | status フィルタ「すべて」を選ぶ | `value:''` を使わず `'all'` 等センチネル（ハイドレーションで 500 しない）— **実ブラウザでのみ顕在化**するので必ず UI 確認 | UI |
| 横-24 | 正規化（null 許容）| 欠落フィールドのある Stripe 行 | `/payments` 一覧 | DTO 正規化が欠落を null として許容し落ちない（`payments/normalize.ts`） | UT |
| 横-25 | Dashboard URL | test / live キー | 行の Dashboard リンク | test モードは `/test/` を含む URL、live は含まない（モード反映） | UI/UT |

---

## 6. 検証の進め方（推奨順）

1. **土台**: 横-07〜10（auth）→ `/dev/login` でセッション偽造ができるので、実運用は dev login で代替し、auth は別途確認。
2. **入部/継続（UI 中心）**: 入-01〜04・継-01〜02 を Playwright で。後期系（入-05・入-11）は ⏱ で UT に寄せる。
3. **重複防止**: 入-09/入-10/継-04/継-05 を実 Stripe＋`stripe listen` で（支払い→`invoice.paid`→再発行拒否）。fresh email を都度使う。
4. **特別対応**: 特-01〜03 を `/special-invoice` で。特-02（前期→後期追加）は台帳の肝。
5. **払い戻し**: Jomon v1 ローカルで 払-01（closed-loop）→ 払-06（onboarding 待ち）→ 払-15/17（送金・再実行冪等）→ 払-21（複数受取人警告）。送金は onboarded test account（`acct_1QUM03CW4ItwVkk3`）に紐付け。
6. **横断 UI**: 横-11〜17（会計一覧・認可表示・USelect 500 回避）。

> ⚠️ = 過去に実ブラウザでのみ顕在化した不具合（USelect 空文字 500）。lint/typecheck/build/Codex では検出できないため **Playwright での実描画確認が必須**。
