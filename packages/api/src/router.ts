import { z } from 'zod'
import { ORPCError } from '@orpc/server'
import { adminProc, pub, userProc } from './orpc'
import {
  isAllowedEmailDomain,
  deriveMailHash,
  sanitizeRedirect,
  createEmailVerification,
  getUserById,
  linkTraqId,
  setPayoutOnboardingStatus,
} from './auth'
import { computeActivityYear, computeTerm, selectPriceId } from './billing'
import {
  createAccountOnboardingLink,
  getOrCreateConnectedAccount,
  getOrCreateCustomer,
  issueInvoice,
  listCheckoutSessions,
  listInvoices,
} from './stripe'
import {
  executePayout,
  listPayouts,
  nextOnboardingStatus,
  processApprovedPayouts,
  type PayoutExecuteConfig,
  type PayoutStatus,
} from './payouts'
import {
  checkoutSessionToRow,
  clampLimit,
  invoiceToRow,
  modeFromSecretKey,
  nextCursor,
  type PaymentPage,
} from './payments'

/**
 * Application router. Procedures are grouped by capability. Browser-redirect /
 * cookie-mutating endpoints (csrf, login, verify-email/confirm, logout) live as
 * Nitro routes; only data operations live here as oRPC procedures.
 */
export const appRouter = {
  health: {
    check: pub.handler(() => ({ ok: true, timestamp: new Date().toISOString() })),
  },

  auth: {
    /** POST /verify-email — send an isct magic-link. Sends mail only; sets no cookie. */
    requestEmailVerification: pub
      .input(z.object({
        email: z.string().email(),
        redirect: z.string().optional(),
      }))
      .handler(async ({ input, context }) => {
        context.assertCsrf()

        if (!isAllowedEmailDomain(input.email, context.config.allowedEmailDomains)) {
          throw new ORPCError('BAD_REQUEST', {
            message: 'email domain is not allowed',
          })
        }

        const mailHash = deriveMailHash(input.email, context.config.mailHashSecret)
        const redirect = input.redirect ? sanitizeRedirect(input.redirect) : null
        const token = await createEmailVerification(context.db, {
          mailHash,
          redirect,
          ttlSec: context.config.emailVerificationTtlSec,
        })

        const link = `${context.config.appOrigin}/verify-email/confirm?token=${encodeURIComponent(token)}`
        await context.mailer.send({
          to: input.email,
          subject: 'Checkin: メールアドレスの確認',
          text: `以下のリンクを開いてログインを完了してください（${Math.round(
            context.config.emailVerificationTtlSec / 60,
          )}分間有効）:\n\n${link}\n\n心当たりがない場合はこのメールを破棄してください。`,
        })

        return { ok: true as const }
      }),

    /**
     * Return the current dual identity (own info only). `member` = traQ-authed,
     * `admin` = accountant, `hasUser` = has a billable isct user linked.
     */
    me: pub.handler(({ context }) => {
      const session = context.session
      return {
        authenticated: session !== null,
        member: !!session?.traqId,
        admin: !!session?.isAdmin,
        hasUser: !!session?.userId,
        traqId: session?.traqId ?? null,
      }
    }),
  },

  membership: {
    /**
     * Issue a **standard** invoice for the logged-in user's own person. The
     * submitted email must hash to the session's `mail_hash` (no issuing for
     * others). `new` fees auto-price by the current term; `continuation` uses
     * the standard price. (membership-billing spec: §発行の認可 — 標準は本人)
     */
    issueInvoice: userProc
      .input(z.object({
        email: z.string().email(),
        name: z.string().min(1),
        feeType: z.enum(['new', 'continuation']),
      }))
      .handler(async ({ input, context }) => {
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

        // Resolve the Customer (DB → Stripe search → create) and persist its id.
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

        const activityYear = computeActivityYear(now)
        const result = await issueInvoice(context.stripe, {
          customerId,
          priceId,
          daysUntilDue: context.billing.invoiceDaysUntilDue,
          // Deterministic key so a rapid double-submit dedupes within Stripe's
          // idempotency window (not a cross-time issuance ledger — see design Risks).
          idempotencyKey: `inv:${customerId}:${priceId}:${activityYear}:${input.feeType}:standard`,
          metadata: {
            fee_type: input.feeType,
            term,
            activity_year: String(activityYear),
          },
        })
        return result
      }),

    /**
     * Issue a **special** (継続特別 ¥2,000) invoice for a target user. Admin
     * (accountant) only. Reuses the target's `stripe_customer_id` if linked,
     * otherwise creates the Customer from the supplied email (required if none).
     * (membership-billing spec: §発行の認可 — 特別は管理者)
     */
    issueSpecialInvoice: adminProc
      .input(z.object({
        userId: z.string().min(1),
        name: z.string().min(1).optional(),
        email: z.string().email().optional(),
      }))
      .handler(async ({ input, context }) => {
        context.assertCsrf()

        const row = await getUserById(context.db, input.userId)
        if (!row) {
          throw new ORPCError('NOT_FOUND', { message: 'target user not found' })
        }

        // Reuse the linked Customer; otherwise an email is required to create one.
        if (!row.stripeCustomerId && !input.email) {
          throw new ORPCError('BAD_REQUEST', {
            message: 'email is required to create a Stripe Customer for this user',
          })
        }
        // When we will create a Customer from the supplied email, the email must
        // belong to the target user (mail_hash match). Otherwise we would
        // permanently link the user row to the wrong email/Customer.
        if (!row.stripeCustomerId && input.email
          && deriveMailHash(input.email, context.config.mailHashSecret) !== row.mailHash) {
          throw new ORPCError('BAD_REQUEST', { message: 'email does not match the target user' })
        }
        const customerId = await getOrCreateCustomer(context.stripe, context.db, {
          userId: row.id,
          stripeCustomerId: row.stripeCustomerId,
          // email is only used when no Customer exists yet (guarded above).
          email: input.email ?? '',
          name: input.name,
          mailHash: row.mailHash,
        })

        const now = new Date()
        const priceId = selectPriceId(context.billing, {
          feeType: 'continuation',
          variant: 'special',
        })
        const activityYear = computeActivityYear(now)
        const result = await issueInvoice(context.stripe, {
          customerId,
          priceId,
          daysUntilDue: context.billing.invoiceDaysUntilDue,
          // Deterministic key so a rapid double-submit dedupes within Stripe's
          // idempotency window (not a cross-time issuance ledger — see design Risks).
          idempotencyKey: `inv:${customerId}:${priceId}:${activityYear}:continuation:special`,
          metadata: {
            fee_type: 'continuation',
            variant: 'special',
            activity_year: String(activityYear),
          },
        })
        return result
      }),
  },

  payments: {
    /**
     * List 請求書由来 (Stripe Invoices) for the accountant. Read-only: requires
     * admin, but no `assertCsrf` (no state change). Rows are normalized to
     * Stripe-independent DTOs; `hasMore`/`nextCursor` drive cursor pagination.
     * (payment-listing spec: §会計のみ / §2 系統 / §フィルタとカーソルページネーション)
     */
    listInvoices: adminProc
      .input(z.object({
        status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']).optional(),
        limit: z.number().int().optional(),
        startingAfter: z.string().optional(),
      }))
      .handler(async ({ input, context }): Promise<PaymentPage> => {
        const mode = modeFromSecretKey(context.billing.stripeSecretKey)
        const page = await listInvoices(context.stripe, {
          status: input.status,
          limit: clampLimit(input.limit),
          startingAfter: input.startingAfter,
        })

        const items = page.data.map(invoice => invoiceToRow(invoice, mode))
        return { items, hasMore: page.has_more, nextCursor: nextCursor(items, page.has_more) }
      }),

    /**
     * List 決済ページ由来 (Stripe Checkout Sessions) for the accountant. Same
     * read-only admin authorization and cursor pagination as `listInvoices`.
     */
    listCheckoutSessions: adminProc
      .input(z.object({
        status: z.enum(['open', 'complete', 'expired']).optional(),
        limit: z.number().int().optional(),
        startingAfter: z.string().optional(),
      }))
      .handler(async ({ input, context }): Promise<PaymentPage> => {
        const mode = modeFromSecretKey(context.billing.stripeSecretKey)
        const page = await listCheckoutSessions(context.stripe, {
          status: input.status,
          limit: clampLimit(input.limit),
          startingAfter: input.startingAfter,
        })

        const items = page.data.map(session => checkoutSessionToRow(session, mode))
        return { items, hasMore: page.has_more, nextCursor: nextCursor(items, page.has_more) }
      }),
  },

  payouts: {
    /**
     * Issue a Stripe **hosted** onboarding link for a payee's Connect connected
     * account so refunds can later pay out to them. Admin (accountant) only:
     * the accountant gets the URL and forwards it to the payee (we don't hold
     * plaintext email). Get-or-create the connected account, create the Account
     * Link, then mark the payee `requested` (unless already `done`).
     * (connect-onboarding spec: §ホスト型 onboarding リンクの発行 / §発行は会計のみ)
     */
    createOnboardingLink: adminProc
      .input(z.object({ userId: z.string().min(1) }))
      .handler(async ({ input, context }) => {
        context.assertCsrf()

        const row = await getUserById(context.db, input.userId)
        if (!row) {
          throw new ORPCError('NOT_FOUND', { message: 'target user not found' })
        }

        const accountId = await getOrCreateConnectedAccount(context.stripe, context.db, {
          userId: row.id,
          stripeConnectedAccountId: row.stripeConnectedAccountId,
          mailHash: row.mailHash,
        })

        // refresh/return land on app-origin pages (the UI is a later change).
        const url = await createAccountOnboardingLink(context.stripe, {
          accountId,
          refreshUrl: `${context.config.appOrigin}/payouts/onboarding/refresh`,
          returnUrl: `${context.config.appOrigin}/payouts/onboarding/return`,
        })

        // Issuing a link advances toward `requested`; `done` is terminal (no
        // regress). `nextOnboardingStatus(_, false)` keeps `done`/`requested` and
        // only `none` would stay `none` — so promote a non-`done` payee to
        // `requested` (skips a redundant write when already `requested`).
        const stayed = nextOnboardingStatus(row.payoutOnboardingStatus, false)
        if (stayed !== 'done' && row.payoutOnboardingStatus !== 'requested') {
          await setPayoutOnboardingStatus(context.db, row.id, 'requested')
        }

        return { url }
      }),

    /**
     * Report a payee's onboarding status (and whether a connected account is
     * linked yet) for the accountant. Read-only: admin, no `assertCsrf`.
     * (connect-onboarding spec: §状態確認は会計のみ)
     */
    onboardingStatus: adminProc
      .input(z.object({ userId: z.string().min(1) }))
      .handler(async ({ input, context }) => {
        const row = await getUserById(context.db, input.userId)
        if (!row) {
          throw new ORPCError('NOT_FOUND', { message: 'target user not found' })
        }
        return {
          status: row.payoutOnboardingStatus,
          hasConnectedAccount: row.stripeConnectedAccountId !== null,
        }
      }),

    /**
     * Ingest Jomon's approved transfer requests and advance each one step
     * (the accounting trigger). Admin (accountant) only + `assertCsrf` (it
     * mutates: upserts payouts, may issue links / run transfers / write back).
     * Returns a plain count summary — no Stripe/Jomon types leak out.
     * Idempotent: jomon_ref upsert + `paid` short-circuit + Stripe idempotency
     * key prevent double payouts. (payout-execution spec: §払い戻し操作は会計のみ)
     */
    processApproved: adminProc
      .handler(async ({ context }) => {
        context.assertCsrf()
        return processApprovedPayouts(
          { db: context.db, stripe: context.stripe, jomon: context.jomon },
          payoutExecuteConfig(context),
        )
      }),

    /**
     * List payouts for the accountant, optionally filtered by status. Read-only:
     * admin, no `assertCsrf`. Rows are Stripe/Jomon-type-free DTOs.
     */
    list: adminProc
      .input(z.object({
        status: z.enum(['pending', 'onboarding_waiting', 'processing', 'paid', 'failed']).optional(),
      }))
      .handler(async ({ input, context }) => {
        const items = await listPayouts(context.db, { status: input.status as PayoutStatus | undefined })
        return { items }
      }),

    /**
     * Advance / retry a single payout by `jomon_ref` (manual resume of an
     * `onboarding_waiting` payout or a retry after `failed`). Admin only +
     * `assertCsrf`. Returns a plain step result (no Stripe/Jomon types).
     */
    execute: adminProc
      .input(z.object({ jomonRef: z.string().min(1) }))
      .handler(async ({ input, context }) => {
        context.assertCsrf()
        return executePayout(
          { db: context.db, stripe: context.stripe, jomon: context.jomon },
          payoutExecuteConfig(context),
          input.jomonRef,
        )
      }),
  },
}

/** Build the payout orchestration config from the request Context. */
function payoutExecuteConfig(context: {
  config: { mailHashSecret: string, appOrigin: string }
  jomonConfig: { payoutCurrency: string }
}): PayoutExecuteConfig {
  return {
    mailHashSecret: context.config.mailHashSecret,
    appOrigin: context.config.appOrigin,
    defaultCurrency: context.jomonConfig.payoutCurrency,
  }
}
