import { adminProc } from '../orpc'
import { listCheckoutSessions, listInvoices } from '../stripe'
import { modeFromSecretKey } from './dashboard'
import { checkoutSessionToRow, invoiceToRow } from './normalize'
import { clampLimit, nextCursor } from './pagination'

/**
 * Payments procedures — the accountant's 入出金一覧. Read-only: they require
 * admin but never `assertCsrf` (no state change). Rows are normalized to
 * Stripe-independent DTOs; the cursor is derived from Stripe's `has_more`.
 * (payment-listing spec: §会計のみ / §2 系統 / §フィルタとカーソルページネーション)
 *
 * The response envelope is `{ data, nextCursor }` (the contract's `listEnvelope`).
 * `hasMore` is not returned: a consumer derives it from `nextCursor !== null`.
 */
export const paymentsRouter = {
  /** List 請求書由来 (Stripe Invoices) for the accountant. */
  listInvoices: adminProc.payments.listInvoices.handler(async ({ input, context }) => {
    const mode = modeFromSecretKey(context.billing.stripeSecretKey)
    const page = await listInvoices(context.stripe, {
      status: input.status,
      limit: clampLimit(input.limit),
      startingAfter: input.startingAfter,
    })

    const data = page.data.map(invoice => invoiceToRow(invoice, mode))
    return { data, nextCursor: nextCursor(data, page.has_more) }
  }),

  /**
   * List 決済ページ由来 (Stripe Checkout Sessions) for the accountant. Same
   * read-only admin authorization and cursor pagination as `listInvoices`.
   */
  listCheckoutSessions: adminProc.payments.listCheckoutSessions.handler(async ({ input, context }) => {
    const mode = modeFromSecretKey(context.billing.stripeSecretKey)
    const page = await listCheckoutSessions(context.stripe, {
      status: input.status,
      limit: clampLimit(input.limit),
      startingAfter: input.startingAfter,
    })

    const data = page.data.map(session => checkoutSessionToRow(session, mode))
    return { data, nextCursor: nextCursor(data, page.has_more) }
  }),
}
