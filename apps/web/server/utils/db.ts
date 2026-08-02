import { createDatabase, type Database } from '@checkin/db'

let cached: Database | undefined

/** サーバーインスタンスごとに Drizzle/MariaDB ハンドルを1つだけ遅延生成し、再利用する。 */
export function useDatabase(): Database {
  cached ??= createDatabase(useRuntimeConfig().databaseUrl || undefined)
  return cached
}
