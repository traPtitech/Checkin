# Checkin — Project Context

Context for OpenSpec change proposals. Read this before drafting specs, designs, or tasks.

## What this is

`Checkin` is a TypeScript monorepo. Features are developed spec-first: every change starts
as an OpenSpec proposal (`/opsx:propose`) → apply (`/opsx:apply`) → archive (`/opsx:archive`).

## Tech stack

- **Language**: TypeScript (strict), Node.js 22, ESM.
- **Monorepo**: pnpm workspaces (no Turborepo). Packages reference each other with `workspace:*`.
- **Frontend + server**: Nuxt 4 (`apps/web`). The backend is **not** a separate service — the
  API is hosted inside Nuxt's Nitro server.
- **API / RPC**: oRPC. Router lives in `packages/api`; the Nitro route `apps/web/server/routes/rpc/[...].ts`
  mounts it; the typed client is provided by `apps/web/app/plugins/orpc.ts`.
- **Database**: MariaDB via Drizzle ORM (`drizzle-orm/mysql2`, dialect `mysql`) in `packages/db`.
  Migrations live in `packages/db/drizzle/` and are committed.
- **Lint/format**: ESLint flat config (`@nuxt/eslint`, stylistic enabled) at the repo root.

## Layout

```
apps/web        Nuxt app (UI + Nitro server hosting oRPC)
packages/api    oRPC router, procedures, request Context
packages/db     Drizzle schema, MariaDB client, migrations
```

## Conventions

- New oRPC procedures: add to `packages/api/src/router.ts`, grouped by capability
  (`appRouter.<capability>.<procedure>`). Build them from `pub` (`packages/api/src/orpc.ts`);
  read DB access via `context.db`.
- New tables: define in `packages/db/src/schema.ts`, then `pnpm db:generate` and commit the
  migration. Never hand-edit generated migration SQL.
- The client imports `AppRouter` **type-only** — never import server implementation into `apps/web` UI code.
- Keep the build green: `pnpm lint`, `pnpm typecheck`, `pnpm build`.

## Local development

```bash
pnpm install
cp .env.example .env
docker compose up -d        # MariaDB
pnpm db:migrate             # apply migrations
pnpm dev                    # Nuxt on http://localhost:3000
```
