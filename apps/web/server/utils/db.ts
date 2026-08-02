import { createDatabase, type Database } from '@checkin/db'

let cached: Database | undefined

/** Lazily create and reuse a single Drizzle/MariaDB handle per server instance. */
export function useDatabase(): Database {
  cached ??= createDatabase(useRuntimeConfig().databaseUrl || undefined)
  return cached
}
