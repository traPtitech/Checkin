# Checkin

A TypeScript monorepo built with **spec-driven development** (OpenSpec).
Stack: **Nuxt 4** (UI + Nitro server) · **oRPC** · **Drizzle ORM** + **MariaDB** · **pnpm workspaces**.

## Layout

```
apps/
  web/            Nuxt 4 app — UI + Nitro server that hosts the oRPC API
packages/
  api/            oRPC router, procedures, request context (@checkin/api)
  db/             Drizzle schema, MariaDB client, migrations (@checkin/db)
openspec/         OpenSpec specs & change proposals
```

The backend is **not** a separate service: the oRPC router (`packages/api`) is mounted inside
Nuxt's Nitro server at `apps/web/server/routes/rpc/[...].ts`, and the typed client is provided by
`apps/web/app/plugins/orpc.ts`.

## Requirements

- Node.js 22 (`.nvmrc`)
- pnpm 10+
- Docker (for local MariaDB)

## Getting started

```bash
pnpm install
cp .env.example .env        # required — DATABASE_URL must be set before `pnpm dev`

docker compose up -d        # start MariaDB
pnpm db:migrate             # apply migrations
pnpm dev                    # Nuxt dev server → http://localhost:3000
```

The home page calls the `health.check` oRPC procedure to confirm the front → Nitro → oRPC wiring.
`health.check` doesn't query the database, but every oRPC request resolves `context.db`, so a
missing `DATABASE_URL` surfaces as a 500 on the home page — copy `.env` first.

## Scripts

| Command            | Description                                  |
| ------------------ | -------------------------------------------- |
| `pnpm dev`         | Run the Nuxt app in dev mode                 |
| `pnpm build`       | Build the Nuxt app (incl. Nitro server)      |
| `pnpm lint`        | ESLint across the monorepo                   |
| `pnpm typecheck`   | Type-check every package                     |
| `pnpm db:generate` | Generate a Drizzle migration from the schema |
| `pnpm db:migrate`  | Apply pending migrations                     |
| `pnpm db:push`     | Push schema directly (dev only)              |
| `pnpm db:studio`   | Open Drizzle Studio                          |

## Spec-driven development (OpenSpec)

Features are built spec-first. From Claude Code (or any supported assistant):

1. `/opsx:propose "<what you want to build>"` — generates `proposal.md`, `design.md`, `tasks.md`
   and updated specs under `openspec/changes/<name>/`.
2. `/opsx:apply` — implement the tasks.
3. `/opsx:archive` — fold the change into `openspec/specs/` once shipped.

`openspec list` shows active changes. See [OpenSpec](https://github.com/Fission-AI/OpenSpec) and
[`openspec/project.md`](openspec/project.md) for project conventions.

## Adding to the API / database

- **New oRPC procedure**: add to `packages/api/src/router.ts` (built from `pub`), grouped by
  capability. The client picks up types automatically via `AppRouter`.
- **New table**: define it in `packages/db/src/schema.ts`, run `pnpm db:generate`, and commit the
  generated migration in `packages/db/drizzle/`.
