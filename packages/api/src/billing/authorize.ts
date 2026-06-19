import type { Variant } from './pricing'

/**
 * Whether a logged-in user may issue a **standard** invoice for the submitted
 * email. Allowed only for one's own person: the `mail_hash` derived from the
 * submitted email MUST equal the session's `mail_hash`.
 * (membership-billing spec: §発行の認可 — 標準は本人)
 */
export function canIssueStandard(sessionMailHash: string, submittedMailHash: string): boolean {
  return sessionMailHash === submittedMailHash
}

/**
 * Whether an actor may issue a **special** (継続特別 ¥2,000) invoice. Only the
 * accountant (admin) may; ordinary users may not, regardless of target.
 * (membership-billing spec: §発行の認可 — 特別は管理者)
 */
export function canIssueSpecial(isAdmin: boolean): boolean {
  return isAdmin
}

/**
 * Gate an issuance by variant. Returns whether the actor is authorized:
 *   - `standard` → caller must be the person (mail_hash match).
 *   - `special`  → caller must be admin.
 */
export function authorizeIssuance(input: {
  variant: Variant
  isAdmin: boolean
  sessionMailHash?: string
  submittedMailHash?: string
}): boolean {
  if (input.variant === 'special') {
    return canIssueSpecial(input.isAdmin)
  }
  if (input.sessionMailHash === undefined || input.submittedMailHash === undefined) {
    return false
  }
  return canIssueStandard(input.sessionMailHash, input.submittedMailHash)
}
