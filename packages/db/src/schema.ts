import { mysqlTable, varchar, timestamp, mysqlEnum, int } from 'drizzle-orm/mysql-core'

/**
 * Auth / identity foundation (OpenSpec change: add-auth-foundation).
 *
 * `users` is the service-internal correspondence table ("対応表"): a person is
 * identified solely by `mail_hash` (HMAC-SHA256 of their normalized isct email).
 * Plaintext email is never stored here. Stripe-side columns (customer / connected
 * account) are added by later changes.
 */
export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // hex HMAC-SHA256 → 64 chars. Unique: one row per person.
  mailHash: varchar('mail_hash', { length: 64 }).notNull().unique(),
  // Stripe Customer reference (non-PII). Added by add-membership-collection: the
  // collection flow does a get-or-create against Stripe and persists the id here
  // so subsequent invoices reuse the same Customer. Plaintext email is still
  // never stored. (identity spec: §Stripe 参照は保持してよい)
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  // Stripe Connect connected-account reference (non-PII). Added by
  // add-connect-onboarding: refunds need a payee account, so the onboarding flow
  // does a get-or-create against Stripe Connect and persists the account id here.
  // Plaintext email is still never stored. (identity spec: §Connect 参照・状態も保持してよい)
  // Unique: a connected account belongs to exactly one person — the constraint
  // is the last line of defence against a get-or-create race linking two rows /
  // creating duplicate Stripe accounts. MariaDB allows multiple NULLs under a
  // unique index, so nullable + unique is fine for the "not yet linked" case.
  stripeConnectedAccountId: varchar('stripe_connected_account_id', { length: 255 }).unique(),
  // Payout onboarding state machine: none → requested (link issued) → done
  // (payouts_enabled + no requirements due). `done` is terminal. Non-PII status.
  // (connect-onboarding spec: §onboarding の状態機械)
  payoutOnboardingStatus: mysqlEnum('payout_onboarding_status', ['none', 'requested', 'done'])
    .notNull()
    .default('none'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
})

/**
 * Server-side sessions. The opaque session id lives in the `__Host-checkin_session`
 * cookie; only its hash is stored here so a DB leak does not expose live cookies.
 * A session represents exactly one actor: a `user` (isct member, by `user_id`) or
 * an `admin` (accountant, by `traq_id`).
 */
export const sessions = mysqlTable('sessions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  idHash: varchar('id_hash', { length: 64 }).notNull().unique(),
  actorType: mysqlEnum('actor_type', ['user', 'admin']).notNull(),
  userId: varchar('user_id', { length: 36 }).references(() => users.id),
  traqId: varchar('traq_id', { length: 255 }),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

/**
 * Single-use, time-limited isct email magic-link tokens. Only the token hash is
 * stored. On successful confirmation we get-or-create the `users` row for
 * `mail_hash` and establish a user session, then navigate to `redirect`.
 */
export const emailVerifications = mysqlTable('email_verifications', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  mailHash: varchar('mail_hash', { length: 64 }).notNull(),
  redirect: varchar('redirect', { length: 1024 }),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

/**
 * Idempotency ledger for Stripe webhooks (OpenSpec change: add-membership-collection).
 * Stripe may deliver the same event multiple times, so each `event_id` is inserted
 * once (unique); a duplicate insert means the event was already handled and its
 * side effect (accountant notification) must not fire again.
 * (payment-webhook spec: §event id による冪等処理)
 */
export const stripeEvents = mysqlTable('stripe_events', {
  id: varchar('id', { length: 36 }).primaryKey(),
  eventId: varchar('event_id', { length: 255 }).notNull().unique(),
  type: varchar('type', { length: 255 }).notNull(),
  receivedAt: timestamp('received_at').notNull().defaultNow(),
})

/**
 * Approved transfer requests pulled from Jomon and paid out via Stripe Connect
 * (OpenSpec change: add-payout-execution). Jomon owns approval/application;
 * Checkin only executes the payout and writes the result back (design §5.3).
 *
 * `jomon_ref` is the unique source key: ingestion upserts by it (`INSERT ... ON
 * DUPLICATE KEY UPDATE` no-op), so re-importing the same request never creates a
 * duplicate row or a double payout. Combined with the Stripe idempotency key
 * (`payout:${jomon_ref}`) and the terminal `paid` short-circuit, payouts run at
 * most once. (payout-execution spec: §取込は jomon_ref で冪等 / §二重送金しない)
 */
export const payouts = mysqlTable('payouts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Opaque Jomon transfer-request id. Unique: one payout row per Jomon request.
  jomonRef: varchar('jomon_ref', { length: 255 }).notNull().unique(),
  // Resolved payee (`users.id`), or NULL when the payee could not be identified
  // by `mail_hash` — such rows stay `pending`, are not paid out, and need an
  // accountant to act. (payout-execution spec: §本人特定（対応表 mail_hash）)
  userId: varchar('user_id', { length: 36 }).references(() => users.id),
  // Amount in the currency's smallest unit (Stripe convention; jpy has no minor
  // unit so this is whole yen). Currency code, e.g. 'jpy'.
  amount: int('amount').notNull(),
  currency: varchar('currency', { length: 8 }).notNull(),
  // Payout state machine: pending → onboarding_waiting (payee onboarding not
  // done) → processing (execution claimed, transfer in flight) → paid (transfer
  // succeeded) / failed (transfer failed). `paid` is terminal. `processing` is an
  // application-level claim: a single ATOMIC conditional UPDATE flips a row to it
  // before the Stripe transfer, so two concurrent runs cannot both pass the
  // pre-transfer check and double-pay. (payout-execution spec: §状態機械 / §二重送金しない)
  status: mysqlEnum('status', ['pending', 'onboarding_waiting', 'processing', 'paid', 'failed'])
    .notNull()
    .default('pending'),
  // Stripe Transfer id, set once the payout succeeds (status `paid`).
  stripeTransferId: varchar('stripe_transfer_id', { length: 255 }),
  // When the settled result was successfully written back to Jomon (NULL until
  // then). Decouples the write-back from the transfer: a transfer can succeed
  // (`paid`) while the write-back fails, so a `paid` re-run with a NULL value
  // here re-attempts ONLY the write-back — it never re-transfers. (Codex hardening)
  jomonWrittenBackAt: timestamp('jomon_written_back_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
})
