import { drizzle } from 'drizzle-orm/mysql2'
import * as schema from './schema'

export type Database = ReturnType<typeof createDatabase>

/**
 * mysql2(MariaDB)を利用した Drizzle のデータベースハンドルを作成する。
 *
 * MariaDB/MySQL が求める default モード(非 planetscale モード)を使用する。
 */
export function createDatabase(connectionString = process.env['DATABASE_URL']) {
  if (!connectionString) {
    throw new Error('DATABASE_URL が設定されていません')
  }

  return drizzle(connectionString, { schema, mode: 'default' })
}
