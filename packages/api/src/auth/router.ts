import { ORPCError } from '@orpc/server'
import { pub } from '../orpc'
import { isAllowedEmailDomain } from './config'
import { deriveMailHash } from './crypto'
import { createEmailVerification } from './email-verification'
import { sanitizeRedirect } from './redirect'

/**
 * Auth procedures. Browser-redirect / cookie-mutating endpoints (csrf, login,
 * verify-email/confirm, logout) live as Nitro routes; only data operations live
 * here as oRPC procedures. Input and output schemas live in the contract
 * (`@checkin/api-contract`), so these handlers only carry behaviour.
 */
export const authRouter = {
  /** POST /verify-email — send an isct magic-link. Sends mail only; sets no cookie. */
  requestEmailVerification: pub.auth.requestEmailVerification.handler(async ({ input, context }) => {
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
      // 分は String で包む。数値をそのまま埋めると restrict-template-expressions が止める。
      text: `以下のリンクを開いてログインを完了してください（${String(Math.round(
        context.config.emailVerificationTtlSec / 60,
      ))}分間有効）:\n\n${link}\n\n心当たりがない場合はこのメールを破棄してください。`,
    })

    return { ok: true as const }
  }),

  /**
   * Return the current dual identity (own info only). `member` = traQ-authed,
   * `admin` = accountant, `hasUser` = has a billable isct user linked.
   */
  me: pub.auth.me.handler(({ context }) => {
    const session = context.session
    return {
      authenticated: session !== null,
      member: !!session?.traqId,
      admin: !!session?.isAdmin,
      hasUser: !!session?.userId,
      traqId: session?.traqId ?? null,
    }
  }),
}
