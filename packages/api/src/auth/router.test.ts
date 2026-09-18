import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call } from '@orpc/server'
import type { Context } from '../orpc'
import { deriveMailHash } from './crypto'
import { authRouter } from './router'

/**
 * `auth` の 2 つのプロシージャが、契約実装形への移設の後も移設前と同じ値を返し、
 * 同じ値を下位へ渡すことを固定するテスト。
 *
 * `me` はセッションの 3 つのフィールドから 5 つの値を作るだけなので、移設で対応を取り違えても
 * 型は通る(すべて真偽値と文字列)。対応そのものを見る。
 */

const verificationMocks = vi.hoisted(() => ({ createEmailVerification: vi.fn() }))
vi.mock('./email-verification', () => verificationMocks)

const MAIL_HASH_SECRET = 'secret-for-test'

/** handler が読むものだけを供給する Context。 */
function authContext(session: unknown, sent: { to?: string, subject?: string, text?: string }): Context {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- handler が読む依存だけを供給する意図的なテストスタブ
  return {
    db: {},
    config: {
      allowedEmailDomains: ['isct.example'],
      mailHashSecret: MAIL_HASH_SECRET,
      emailVerificationTtlSec: 1800,
      appOrigin: 'https://checkin.example',
    },
    mailer: {
      send: (message: { to: string, subject: string, text: string }) => {
        Object.assign(sent, message)
        return Promise.resolve()
      },
    },
    session,
    assertCsrf: () => {},
  } as unknown as Context
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('auth.me', () => {
  it('セッションが無いときはすべて偽で traqId は null', async () => {
    const result = await call(authRouter.me, undefined, { context: authContext(null, {}) })

    expect(result).toEqual({
      authenticated: false,
      member: false,
      admin: false,
      hasUser: false,
      traqId: null,
    })
  })

  it('traQ 認証済みだけのセッションでは member だけが真になる', async () => {
    const session = { traqId: 'taro', userId: null, isAdmin: false }

    const result = await call(authRouter.me, undefined, { context: authContext(session, {}) })

    expect(result).toEqual({
      authenticated: true,
      member: true,
      admin: false,
      hasUser: false,
      traqId: 'taro',
    })
  })

  it('isct ユーザーと会計担当者の 2 つは別のフィールドに現れる', async () => {
    const session = { traqId: null, userId: 'u1', isAdmin: true }

    const result = await call(authRouter.me, undefined, { context: authContext(session, {}) })

    expect(result).toEqual({
      authenticated: true,
      member: false,
      admin: true,
      hasUser: true,
      traqId: null,
    })
  })
})

describe('auth.requestEmailVerification', () => {
  it('許可されたドメインなら、mail_hash とサニタイズした redirect で発行し、リンクを送る', async () => {
    verificationMocks.createEmailVerification.mockResolvedValue('tok en/&')
    const sent: { to?: string, subject?: string, text?: string } = {}

    const result = await call(
      authRouter.requestEmailVerification,
      { email: 'taro@isct.example', redirect: 'https://evil.example/path' },
      { context: authContext(null, sent) },
    )

    expect(verificationMocks.createEmailVerification).toHaveBeenCalledWith(expect.anything(), {
      mailHash: deriveMailHash('taro@isct.example', MAIL_HASH_SECRET),
      // 自サイト外の redirect は '/' に落ちる。
      redirect: '/',
      ttlSec: 1800,
    })
    expect(sent.to).toBe('taro@isct.example')
    // トークンは URL エンコードして埋める。
    expect(sent.text).toContain('https://checkin.example/verify-email/confirm?token=tok%20en%2F%26')
    // TTL は分に直して本文に出す。
    expect(sent.text).toContain('30分間有効')
    expect(result).toEqual({ ok: true })
  })

  it('redirect を省くと発行時の redirect は null になる', async () => {
    verificationMocks.createEmailVerification.mockResolvedValue('tok')

    await call(
      authRouter.requestEmailVerification,
      { email: 'taro@isct.example' },
      { context: authContext(null, {}) },
    )

    expect(verificationMocks.createEmailVerification).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirect: null }),
    )
  })

  it('許可されていないドメインは発行もメール送信もせずに拒否する', async () => {
    const sent: { to?: string } = {}

    await expect(call(
      authRouter.requestEmailVerification,
      { email: 'taro@other.example' },
      { context: authContext(null, sent) },
    )).rejects.toThrow()

    expect(verificationMocks.createEmailVerification).not.toHaveBeenCalled()
    expect(sent.to).toBeUndefined()
  })
})
