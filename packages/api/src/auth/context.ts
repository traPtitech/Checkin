import { ORPCError } from '@orpc/server'
import type { SessionActor } from './session'

export interface UserActor {
  userId: string
  mailHash: string
}

export interface AdminActor {
  traqId: string
}

export interface AuthHelpers {
  /** Require a logged-in isct user. Throws UNAUTHORIZED otherwise. */
  requireUser(): UserActor
  /** Require an accountant (admin). Throws UNAUTHORIZED/FORBIDDEN otherwise. */
  requireAdmin(): AdminActor
  /** Enforce double-submit CSRF on a state-changing call. Throws FORBIDDEN if invalid. */
  assertCsrf(): void
}

/**
 * Build the per-request authorization helpers from the resolved session and
 * CSRF validity. (session spec: §認可ヘルパ requireUser / requireAdmin,
 * §状態変更要求の CSRF 検証)
 */
export function createAuthHelpers(session: SessionActor | null, csrfValid: boolean): AuthHelpers {
  return {
    requireUser() {
      if (session?.actor === 'user') {
        return { userId: session.userId, mailHash: session.mailHash }
      }
      throw new ORPCError('UNAUTHORIZED', { message: 'login required' })
    },
    requireAdmin() {
      if (session?.actor === 'admin') {
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
