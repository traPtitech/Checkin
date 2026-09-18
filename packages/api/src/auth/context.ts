import { ORPCError } from '@orpc/server'
import type { SessionIdentity } from './session'

/** A traQ-authenticated member (the traQ identity on the session). */
export interface MemberActor {
  traqId: string
}

/** A billable isct user (the user identity on the session). */
export interface UserActor {
  userId: string
  mailHash: string
}

/** An accountant (the `isAdmin` flag on the session). */
export interface AdminActor {
  /** The traQ ID, when present (admin sessions are always traQ-authenticated). */
  traqId: string | null
}

export interface AuthHelpers {
  /** Require a traQ-authenticated member (traqId). Throws UNAUTHORIZED otherwise. */
  requireMember(): MemberActor
  /** Require a billable isct user (userId). Throws UNAUTHORIZED otherwise. */
  requireUser(): UserActor
  /** Require an accountant (isAdmin). Throws UNAUTHORIZED/FORBIDDEN otherwise. */
  requireAdmin(): AdminActor
  /** Enforce double-submit CSRF on a state-changing call. Throws FORBIDDEN if invalid. */
  assertCsrf(): void
}

/**
 * Build the per-request authorization helpers from the resolved (dual-identity)
 * session and CSRF validity. Each helper checks the relevant identity field:
 * `requireMember` needs traqId, `requireUser` needs userId, `requireAdmin` needs
 * isAdmin. A single session may satisfy several. (session spec: §認可ヘルパ
 * requireMember / requireUser / requireAdmin, §状態変更要求の CSRF 検証)
 */
export function createAuthHelpers(session: SessionIdentity | null, csrfValid: boolean): AuthHelpers {
  return {
    requireMember() {
      if (session?.traqId) {
        return { traqId: session.traqId }
      }
      throw new ORPCError('UNAUTHORIZED', { message: 'traQ login required' })
    },
    requireUser() {
      if (session?.userId && session.mailHash) {
        return { userId: session.userId, mailHash: session.mailHash }
      }
      throw new ORPCError('UNAUTHORIZED', { message: 'login required' })
    },
    requireAdmin() {
      if (session?.isAdmin) {
        return { traqId: session.traqId }
      }
      if (session) {
        throw new ORPCError('FORBIDDEN', { message: 'accountant access required' })
      }
      throw new ORPCError('UNAUTHORIZED', { message: 'login required' })
    },
    assertCsrf() {
      if (!csrfValid) {
        throw new ORPCError('FORBIDDEN', { message: 'CSRF token missing or invalid' })
      }
    },
  }
}
