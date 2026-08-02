# Checkin — Project Context

Context for OpenSpec change proposals. Read this before drafting specs, designs, or tasks.

## What this is

`Checkin` is a TypeScript monorepo. Features are developed spec-first: every change starts
as an OpenSpec proposal (`/opsx:propose`) → apply (`/opsx:apply`) → archive (`/opsx:archive`).

## Tech stack

- **Language**: TypeScript (strict), Node.js 24, ESM.
- **Monorepo**: pnpm workspaces (no Turborepo). Packages reference each other with `workspace:*`.
- **Frontend + server**: Nuxt 4 (`apps/web`). The backend is **not** a separate service — the
  API is hosted inside Nuxt's Nitro server.
- **API / RPC**: oRPC, contract-first. The contract (`oc` from `@orpc/contract`) lives in
  `packages/api-contract`; `packages/api` implements it via `implement(contract)` and is mounted
  by the Nitro route `apps/web/server/routes/rpc/[...].ts`. The typed client in
  `apps/web/app/plugins/orpc.ts` links against the contract, not the server implementation.
- **Database**: MariaDB via Drizzle ORM (`drizzle-orm/mysql2`, dialect `mysql`) in `packages/db`.
  Migrations live in `packages/db/drizzle/` and are committed.
- **Lint/format**: ESLint flat config (`@nuxt/eslint`, stylistic enabled, type-aware rules) at
  the repo root. `knip` checks for unused files/exports/dependencies.
- **Testing**: vitest. Test files live next to source as `*.test.ts`; `pnpm test` runs the
  workspace-wide suite.
- **Git hooks**: husky + lint-staged run `eslint --fix` on staged files, then `pnpm typecheck`
  and `pnpm test`, on every commit.

## Layout

```
apps/web               Nuxt app (UI + Nitro server hosting oRPC)
packages/api-contract  oRPC contract (procedure input/output/error specs, no implementation)
packages/api           oRPC router — implements packages/api-contract, request Context
packages/db            Drizzle schema, MariaDB client, migrations
```

## Conventions

- New oRPC procedures: first define the contract in `packages/api-contract/src/`, grouped by
  capability, using `oc` (`@orpc/contract`) for input/output/error schemas. Then implement it in
  `packages/api/src/router.ts` (`appRouter.<capability>.<procedure>`), building handlers from
  `pub` (`packages/api/src/orpc.ts`, `implement(contract).$context<Context>()`); access the DB
  via `context.db`.
- New tables: define in `packages/db/src/schema.ts`, then `pnpm db:generate` and commit the
  migration. Never hand-edit generated migration SQL.
- The client imports the contract (`@checkin/api-contract`), typed via `ContractRouterClient`
  from `@orpc/contract` — never import `@checkin/api` (the server implementation) into `apps/web`
  UI code.
- Keep the build green: `pnpm lint`, `pnpm knip`, `pnpm typecheck`, `pnpm test`, `pnpm build`.

## Local development

```bash
pnpm install
cp .env.example .env
docker compose up -d        # MariaDB
pnpm db:migrate             # apply migrations
pnpm dev                    # Nuxt on http://localhost:3000
```
