import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Normalize an email for stable hashing: trim surrounding whitespace and
 * lowercase both local-part and domain. (identity spec: §正規化と導出)
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Derive the service-internal person key `mail_hash` from an isct email.
 *
 * `mail_hash = HMAC-SHA256(secret, normalize(email))` as lowercase hex.
 * The secret MUST be configured; we never fall back to a weak default,
 * because a changed/empty secret would silently break the correspondence
 * table. (identity spec: §秘密鍵が未設定なら処理を拒否する)
 */
export function deriveMailHash(email: string, secret: string): string {
  if (!secret) {
    throw new Error('MAIL_HASH_SECRET is not set; refusing to derive mail_hash')
  }
  return createHmac('sha256', secret).update(normalizeEmail(email)).digest('hex')
}

/** SHA-256 hex digest — used to store hashes of opaque tokens (never the raw token). */
export function sha256hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Generate a high-entropy, URL-safe opaque token (sessions, magic links, CSRF). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Constant-time string comparison. Both inputs are hashed to a fixed-length
 * digest first, so the comparison time does not depend on input length (an
 * early length check would leak through a different code path). Callers must
 * still reject empty values separately where "present" matters.
 */
export function safeEqual(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest()
  const bh = createHash('sha256').update(b).digest()
  return timingSafeEqual(ah, bh)
}
