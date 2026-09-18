import { ORPCError } from '@orpc/server'
import { adminProc, userProc, type Context } from '../orpc'
import {
  deriveMailHash,
  getOrCreateUserByMailHash,
  getUserById,
  isAllowedEmailDomain,
  linkTraqId,
  type BillingUserRow,
} from '../auth'
import { computeActivityYear, computeTerm, selectPriceId } from '../billing'
import {
  halvesForCoverage,
  issueWithLedger,
  standardActivityYear,
  standardCoverage,
} from '../ledger'
import {
  createDraftInvoice,
  finalizeAndSendInvoice,
  getOrCreateCustomer,
  voidInvoiceSafe,
} from '../stripe'

/**
 * Membership procedures — issuance of 会費 invoices. Input and output schemas
 * live in the contract (`@checkin/api-contract`), so these handlers only carry
 * behaviour.
 */
export const membershipRouter = {
  /**
   * Issue a **standard** invoice for the logged-in user's own person. The
   * submitted email must hash to the session's `mail_hash` (no issuing for
   * others). `new` fees auto-price by the current term; `continuation` uses
   * the standard price. (membership-billing spec: §発行の認可 — 標準は本人)
   */
  issueInvoice: userProc.membership.issueInvoice.handler(async ({ input, context }) => {
    const user = context.requireUser()
    context.assertCsrf()

    // Authorize: the submitted email must be the caller's own (mail_hash match).
    const submittedMailHash = deriveMailHash(input.email, context.config.mailHashSecret)
    if (submittedMailHash !== user.mailHash) {
      throw new ORPCError('FORBIDDEN', { message: 'cannot issue an invoice for another person' })
    }

    // If the caller is also traQ-authenticated, link their authenticated traQ
    // ID onto this user row (未設定なら保存; 上書きしない). Best-effort: a
    // conflict (traq_id owned by another user) is logged, never fails the
    // invoice. We track whether the session traq_id legitimately belongs to
    // this user (`linked`/`exists`) so we never stamp a conflicting (foreign)
    // traQ ID into the Customer metadata below.
    // (membership-billing spec: §支払い時の traQ ID 連結)
    const traqId = context.session?.traqId ?? null
    let linkedTraqId: string | null = null
    if (traqId) {
      const result = await linkTraqId(context.db, user.userId, traqId)
      if (result === 'conflict') {
        console.warn(`linkTraqId conflict on issueInvoice: traqId=${traqId} userId=${user.userId}`)
      }
      else {
        linkedTraqId = traqId
      }
    }

    // Standard issuance only (special is admin-only via issueSpecialInvoice).
    const now = new Date()
    const term = computeTerm(now)
    const priceId = selectPriceId(context.billing, {
      feeType: input.feeType,
      term,
      variant: 'standard',
    })

    // Ledger gate (issuance-ledger): determine the half-period(s) this payment
    // covers and the activity year it covers (継続 → 翌年度), then issue through
    // the ledger so a payable invoice never exists without a slot guard. The
    // Customer is resolved lazily inside `createDraft` (only on the `free`
    // path), so a rejected duplicate creates no Customer/invoice side effects.
    const coverage = standardCoverage(input.feeType, term)
    const activityYear = standardActivityYear(now, input.feeType)
    const outcome = await issueWithLedger(
      context.db,
      { userId: user.userId, activityYear, halves: halvesForCoverage(coverage) },
      {
        createDraft: async () => {
          const row = await getUserById(context.db, user.userId)
          if (!row) {
            throw new ORPCError('NOT_FOUND', { message: 'user not found' })
          }
          const customerId = await getOrCreateCustomer(context.stripe, context.db, {
            userId: row.id,
            stripeCustomerId: row.stripeCustomerId,
            email: input.email,
            name: input.name,
            mailHash: user.mailHash,
            // Stamp the authenticated traQ ID into Customer metadata when present
            // (reference keys stay mail_hash / customer_id). Use the session traq_id
            // ONLY when it legitimately belongs to this user (link result
            // linked/exists); on conflict it is owned by someone else, so fall back
            // to the user's already-linked id and never the foreign session traq_id.
            traqId: linkedTraqId ?? row.traqId ?? undefined,
          })
          const { invoiceId } = await createDraftInvoice(context.stripe, {
            customerId,
            priceId,
            daysUntilDue: context.billing.invoiceDaysUntilDue,
            metadata: {
              fee_type: input.feeType,
              term,
              activity_year: String(activityYear),
            },
          })
          return invoiceId
        },
        finalizeAndSend: id => finalizeAndSendInvoice(context.stripe, id),
        voidInvoice: id => voidInvoiceSafe(context.stripe, id),
      },
    )
    if (!outcome.ok) {
      throw new ORPCError('CONFLICT', {
        message: outcome.rejected === 'paid'
          ? '対象の期間は既に支払い済みです。'
          : '支払い対象の期間が既存の請求と重複しています。',
      })
    }
    return { invoiceId: outcome.invoiceId, hostedInvoiceUrl: outcome.hostedInvoiceUrl }
  }),

  /**
   * Issue a **special** (継続特別 ¥2,000) invoice for a target user. Admin
   * (accountant) only. Reuses the target's `stripe_customer_id` if linked,
   * otherwise creates the Customer from the supplied email (required if none).
   * (membership-billing spec: §発行の認可 — 特別は管理者)
   */
  issueSpecialInvoice: adminProc.membership.issueSpecialInvoice.handler(async ({ input, context }) => {
    context.assertCsrf()

    const row = await getUserById(context.db, input.userId)
    if (!row) {
      throw new ORPCError('NOT_FOUND', { message: 'target user not found' })
    }
    return issueSpecialForRow(context, {
      row,
      email: input.email,
      name: input.name,
      coverage: input.coverage,
      activityYear: input.activityYear,
    })
  }),

  /**
   * Issue a **special** (継続特別 ¥2,000) invoice selecting the target by
   * EMAIL. Admin (accountant) only. The email IS the person selector: we
   * get-or-create the person row keyed by its `mail_hash`, so a first-time,
   * never-before-seen member is created on the spot (no prior login / userId
   * required). The Customer is then created from that same email, so the
   * spec's "管理者が指定したメール＝対象者" mail_hash match holds by construction.
   * The domain must be an allowed isct domain — same guard as self-issuance —
   * so a typo can't mint a junk person row. (membership-billing spec: §発行の認可 — 特別は管理者)
   */
  issueSpecialInvoiceByEmail: adminProc.membership.issueSpecialInvoiceByEmail.handler(async ({ input, context }) => {
    context.assertCsrf()

    if (!isAllowedEmailDomain(input.email, context.config.allowedEmailDomains)) {
      throw new ORPCError('BAD_REQUEST', { message: 'email domain is not allowed' })
    }

    // Resolve the person by mail_hash, creating the row for a first-time
    // member, then load its full billing row (Stripe links/state).
    const mailHash = deriveMailHash(input.email, context.config.mailHashSecret)
    const base = await getOrCreateUserByMailHash(context.db, mailHash)
    const row = await getUserById(context.db, base.id)
    if (!row) {
      // get-or-create just guaranteed the row exists; a miss is an internal fault.
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: 'failed to resolve target user' })
    }
    return issueSpecialForRow(context, {
      row,
      email: input.email,
      name: input.name,
      coverage: input.coverage,
      activityYear: input.activityYear,
    })
  }),
}

/**
 * Core of special (継続特別 ¥2,000) issuance for an already-resolved person row.
 * Shared by both selectors (`issueSpecialInvoice` by userId / `issueSpecialInvoiceByEmail`
 * by email). Reserves the single target half through the ledger so a payable
 * invoice never exists without a guard; Customer resolution + email validation
 * happen lazily in `createDraft` (only on the `free` path), so a rejected
 * duplicate has no side effects. (issuance-ledger spec / membership-billing spec)
 */
async function issueSpecialForRow(
  context: Context,
  params: {
    row: BillingUserRow
    /** Used only when the row has no Customer yet (to create one). */
    email?: string
    name?: string
    coverage: 'zenki' | 'kouki'
    /** Defaults to the current activity year; pass next year for a 後期 継続特別. */
    activityYear?: number
  },
) {
  const { row } = params
  const now = new Date()
  const activityYear = params.activityYear ?? computeActivityYear(now)
  const outcome = await issueWithLedger(
    context.db,
    { userId: row.id, activityYear, halves: halvesForCoverage(params.coverage) },
    {
      createDraft: async () => {
        // A special invoice bills a person via their isct email; a payout-only
        // recipient (traq_id, no mail_hash) has no email identity to bill.
        if (!row.mailHash) {
          throw new ORPCError('BAD_REQUEST', {
            message: 'target user has no isct email identity (payout-only)',
          })
        }
        // Reuse the linked Customer; otherwise an email is required to create one.
        if (!row.stripeCustomerId && !params.email) {
          throw new ORPCError('BAD_REQUEST', {
            message: 'email is required to create a Stripe Customer for this user',
          })
        }
        // When we will create a Customer from the supplied email, the email must
        // belong to the target user (mail_hash match). Otherwise we would
        // permanently link the user row to the wrong email/Customer. (For the
        // by-email selector the row is keyed by this email's mail_hash, so the
        // check is trivially satisfied.)
        if (!row.stripeCustomerId && params.email
          && deriveMailHash(params.email, context.config.mailHashSecret) !== row.mailHash) {
          throw new ORPCError('BAD_REQUEST', { message: 'email does not match the target user' })
        }
        const customerId = await getOrCreateCustomer(context.stripe, context.db, {
          userId: row.id,
          stripeCustomerId: row.stripeCustomerId,
          // email is only used when no Customer exists yet (guarded above).
          email: params.email ?? '',
          name: params.name,
          mailHash: row.mailHash,
        })
        const priceId = selectPriceId(context.billing, {
          feeType: 'continuation',
          variant: 'special',
        })
        const { invoiceId } = await createDraftInvoice(context.stripe, {
          customerId,
          priceId,
          daysUntilDue: context.billing.invoiceDaysUntilDue,
          metadata: {
            fee_type: 'continuation',
            variant: 'special',
            coverage: params.coverage,
            activity_year: String(activityYear),
          },
        })
        return invoiceId
      },
      finalizeAndSend: id => finalizeAndSendInvoice(context.stripe, id),
      voidInvoice: id => voidInvoiceSafe(context.stripe, id),
    },
  )
  if (!outcome.ok) {
    throw new ORPCError('CONFLICT', {
      message: outcome.rejected === 'paid'
        ? '対象の期間は既に支払い済みです。'
        : '支払い対象の期間が既存の請求と重複しています。',
    })
  }
  return { invoiceId: outcome.invoiceId, hostedInvoiceUrl: outcome.hostedInvoiceUrl }
}
