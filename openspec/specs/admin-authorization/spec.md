# admin-authorization

## Purpose

会計（管理者）を traQ OAuth で認証し、環境変数の traQ ID 許可リストで認可して管理者セッションを確立する。会計管理は DB の管理者テーブルではなく許可リスト（将来 traQ グループ連携へ拡張可能）で行う。

## Requirements

### Requirement: traQ OAuth による会計ログイン

会計（管理者）は traQ OAuth の authorization code フロー（PKCE 併用）でログイン SHALL。`GET /login` は state と PKCE code_verifier を生成・保存して traQ の認可エンドポイントへリダイレクトし、コールバックで `state` を検証し、code を access token に交換して traQ のユーザー情報（traq_id）を取得 MUST。`state` 不一致や code 交換失敗時はセッションを確立せずエラーとする SHALL。

#### Scenario: 正常な OAuth ログイン

- **WHEN** 会計が `GET /login` を開始し、traQ で認可してコールバックに戻る
- **THEN** `state` が検証され、code が token に交換され、traq_id が取得される

#### Scenario: state 不一致は拒否

- **WHEN** コールバックの `state` が保存値と一致しない
- **THEN** セッションは確立されず、エラーとして扱われる

### Requirement: env 許可リストによる会計判定

システムは、OAuth で得た traq_id が環境変数の会計 traQ ID 許可リストに含まれる場合のみ、管理者（会計）セッションを確立 SHALL。許可リスト外の traq_id には管理者権限を付与しては SHALL NOT。会計の管理は DB の管理者テーブルではなく、この許可リスト（将来 traQ グループ連携へ拡張可能）で行う MUST。

#### Scenario: 許可リスト内は会計になる

- **WHEN** 許可リストに含まれる traq_id でログインが完了する
- **THEN** 管理者（会計）セッションが確立される

#### Scenario: 許可リスト外は会計にならない

- **WHEN** 許可リストに含まれない traq_id でログインが完了する
- **THEN** 管理者セッションは確立されず、会計権限は付与されない

### Requirement: ログインの redirect 保持

`GET /login` は `redirect` クエリを受け取り、OAuth フローを通じて保持 SHALL。ログイン成立後、指定された **同一サイト内** の `redirect` 先へ遷移する MUST。オープンリダイレクトを防ぐため、外部 URL への `redirect` は拒否または無視する SHALL。

#### Scenario: 同一サイトの redirect は保持される

- **WHEN** `GET /login?redirect=/payments` からログインが完了する
- **THEN** ログイン後に `/payments` へ遷移する

#### Scenario: 外部 redirect は拒否される

- **WHEN** `redirect` に外部 URL（別オリジン）が指定される
- **THEN** その遷移先は使われず、安全な既定先へ遷移する
