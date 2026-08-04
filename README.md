# Checkin

**スペック駆動開発**(OpenSpec)で構築された TypeScript モノレポ。
スタック: **Nuxt 4**(UI + Nitro サーバー)・**oRPC**・**Drizzle ORM** + **MariaDB**・**pnpm workspaces**。

## 構成

```
apps/
  web/            Nuxt 4 アプリ — oRPC API をホストする UI + Nitro サーバー
packages/
  api-contract/   oRPC コントラクト — プロシージャの入出力・エラー仕様 (@checkin/api-contract)
  api/            oRPC ルーター — コントラクトを実装、リクエストコンテキスト (@checkin/api)
  db/             Drizzle スキーマ、MariaDB クライアント、マイグレーション (@checkin/db)
openspec/         OpenSpec の仕様と変更提案
```

バックエンドは独立したサービス**ではない**: oRPC ルーター(`packages/api`、`packages/api-contract`
のコントラクトを実装)は `apps/web/server/routes/rpc/[...].ts` で Nuxt の Nitro サーバー内に
マウントされており、型付きクライアント — サーバー実装ではなくコントラクトにリンクされる — は
`apps/web/app/plugins/orpc.ts` から提供される。

## 動作要件

- Node.js 24(`.nvmrc`)
- pnpm 11+
- Docker(ローカル MariaDB 用)
- [gitleaks](https://github.com/gitleaks/gitleaks#installing) — pre-commit フックがこれなしでは
  コミットを拒否する。CI でもスキャンするが、それはプッシュが GitHub に届いた後なので、
  漏洩したシークレットに対しては手遅れになる。

## はじめかた

```bash
pnpm install
cp .env.example .env        # `pnpm dev` の前に必要な値を設定すること

docker compose up -d        # MariaDB を起動
pnpm db:migrate             # マイグレーションを適用
pnpm dev                    # Nuxt 開発サーバー → http://localhost:3000
```

ホームページは静的で oRPC は呼び出さない。API のプロシージャ(価格・商品・請求・Checkout)は
Stripe を呼ぶため `STRIPE_SECRET_KEY` が要る。`DATABASE_URL` はマイグレーションと将来のドメイン
機能で使う。

## スクリプト

| コマンド            | 説明                                          |
| ------------------- | --------------------------------------------- |
| `pnpm dev`         | Nuxt アプリを開発モードで実行                  |
| `pnpm build`       | Nuxt アプリをビルド(Nitro サーバーを含む)     |
| `pnpm lint`        | モノレポ全体に ESLint を実行                   |
| `pnpm knip`        | 未使用のファイル・エクスポート・依存関係を検出 |
| `pnpm typecheck`   | 全パッケージの型チェック                       |
| `pnpm test`        | vitest スイートを実行                          |
| `pnpm db:generate` | スキーマから Drizzle マイグレーションを生成    |
| `pnpm db:migrate`  | 未適用のマイグレーションを適用                 |
| `pnpm db:push`     | スキーマを直接反映(開発専用)                  |
| `pnpm db:studio`   | Drizzle Studio を開く                          |

## スペック駆動開発(OpenSpec)

機能はスペックファーストで構築される。Claude Code(または対応する他のアシスタント)から:

1. `/opsx:propose "<構築したい内容>"` — `openspec/changes/<name>/` 配下に `proposal.md`・
   `design.md`・`tasks.md` と更新された仕様を生成する。
2. `/opsx:apply` — タスクを実装する。
3. `/opsx:archive` — 出荷後に変更を `openspec/specs/` に統合する。

`openspec list` で有効な変更を確認できる。プロジェクトの規約については
[OpenSpec](https://github.com/Fission-AI/OpenSpec) と
[`openspec/project.md`](openspec/project.md) を参照。

## API / データベースへの追加

- **新しい oRPC プロシージャ**: `@orpc/contract` の `oc` を使って `packages/api-contract/src/`
  にコントラクトを定義し、それを `packages/api/src/router.ts`(`pub` から構築)に機能単位で
  グループ化して実装する。クライアントはコントラクトから自動的に型を取得する。
- **新しいテーブル**: `packages/db/src/schema.ts` に定義し、`pnpm db:generate` を実行して、
  生成されたマイグレーションを `packages/db/drizzle/` にコミットする。
