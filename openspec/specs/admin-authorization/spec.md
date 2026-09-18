# admin-authorization

## Purpose

traQ OAuth でログインを認証し、**会員セッション**を確立する。会計（管理者）はその traQ ID 許可リスト・サブセット（`isAdmin`）。会計管理は DB の管理者テーブルではなく許可リスト（将来 traQ グループ連携へ拡張可能）で行う。

## Requirements

### Requirement: traQ OAuth による会計ログイン

利用者（現役会員）・会計はともに traQ OAuth の authorization code フロー（PKCE 併用）でログイン SHALL。`GET /login` は state と PKCE code_verifier を生成・保存して traQ の認可エンドポイントへリダイレクトし、コールバックで `state` を検証し、code を access token に交換して traQ のユーザー情報（traq_id）を取得 MUST。ログイン成立で**会員セッション**を確立する（traQ 認証済み）。`state` 不一致や code 交換失敗時はセッションを確立せずエラーとする SHALL。

#### Scenario: 正常な OAuth ログインで会員セッション

- **WHEN** traQ で認可してコールバックに戻る
- **THEN** `state` が検証され、code が token に交換され、traq_id を持つ会員セッションが確立される

#### Scenario: state 不一致は拒否

- **WHEN** コールバックの `state` が保存値と一致しない
- **THEN** セッションは確立されず、エラーとして扱われる

### Requirement: env 許可リストによる会計判定

システムは、traQ ログインで得た traq_id が環境変数の会計 traQ ID 許可リストに含まれる場合に**会計権限（`isAdmin`）**を付与 SHALL。許可リスト外の traq_id には会計権限を付与しては SHALL NOT が、ログイン自体は成立し**会員セッション**として扱う MUST。会計の管理は DB の管理者テーブルではなく、この許可リスト（将来 traQ グループ連携へ拡張可能）で行う。

#### Scenario: 許可リスト内は会計になる

- **WHEN** 許可リストに含まれる traq_id でログインが完了する
- **THEN** 会員セッションに会計権限（`isAdmin`）が付与される

#### Scenario: 許可リスト外は会員のまま

- **WHEN** 許可リストに含まれない traq_id でログインが完了する
- **THEN** ログインは成立し会員セッションになるが、会計権限は付与されない

### Requirement: ログインの redirect 保持

`GET /login` は `redirect` クエリを受け取り、OAuth フローを通じて保持 SHALL。ログイン成立後、指定された **同一サイト内** の `redirect` 先へ遷移する MUST。オープンリダイレクトを防ぐため、外部 URL への `redirect` は拒否または無視する SHALL。

#### Scenario: 同一サイトの redirect は保持される

- **WHEN** `GET /login?redirect=/payments` からログインが完了する
- **THEN** ログイン後に `/payments` へ遷移する

#### Scenario: 外部 redirect は拒否される

- **WHEN** `redirect` に外部 URL（別オリジン）が指定される
- **THEN** その遷移先は使われず、安全な既定先へ遷移する
