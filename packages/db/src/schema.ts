import { mysqlTable, varchar, timestamp } from 'drizzle-orm/mysql-core'

/**
 * スキーマの仮置き。
 *
 * 実際のテーブルは機能ごとに OpenSpec の変更提案(`/opsx:propose`)を通じて
 * 追加される。以下の `users` テーブルは、Drizzle/マイグレーションツールが
 * 生成対象を持ち、エンドツーエンドの疎通を検証できるようにするためだけに
 * 存在する。仕様が定まり次第、置き換え・拡張すること。
 */
export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
