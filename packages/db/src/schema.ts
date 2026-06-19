import { mysqlTable, varchar, timestamp } from 'drizzle-orm/mysql-core'

/**
 * Schema placeholder.
 *
 * Real tables are added per feature through OpenSpec change proposals
 * (`/opsx:propose`). The `users` table below only exists so that the
 * Drizzle/migration tooling has something to generate against and the
 * end-to-end wiring can be verified. Replace/extend it as specs land.
 */
export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
