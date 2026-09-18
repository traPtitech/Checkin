import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthConfig } from '@checkin/api'

/**
 * `resolveAuthConfig` が env(runtimeConfig)の SMTP の値を `MailerConfig` の
 * どのフィールドへ運ぶかを固定する。運び先を取り違えても型は通る(host / user /
 * pass はいずれも string)ので、対応そのものを見る。
 *
 * `resolveAuthConfig` は解決結果をモジュール変数に載せるため、runtimeConfig を
 * 変えるたびに `vi.resetModules()` で読み直す。
 */

/** runtimeConfig のうち `resolveAuthConfig` が読むものを全て備えた形。 */
function runtimeConfig(overrides: Record<string, string>): Record<string, unknown> {
  return {
    mailHashSecret: 'test-mail-hash-secret',
    allowedEmailDomains: 'm.isct.ac.jp',
    appOrigin: 'http://localhost:3000',
    emailVerificationTtlSec: '1800',
    sessionTtlSec: '2592000',
    accountantTraqIds: '',
    trustForwardAuth: '',
    traqClientId: '',
    traqClientSecret: '',
    traqAuthorizeUrl: '',
    traqTokenUrl: '',
    traqUserinfoUrl: '',
    traqScope: '',
    traqUserIdField: 'name',
    mailerDriver: 'log',
    mailFrom: 'noreply@localhost',
    smtpHost: '',
    smtpPort: '587',
    smtpSecure: '',
    smtpUser: '',
    smtpPassword: '',
    ...overrides,
  }
}

async function resolveWith(overrides: Record<string, string>): Promise<AuthConfig> {
  vi.stubGlobal('useRuntimeConfig', () => runtimeConfig(overrides))
  vi.resetModules()
  const { resolveAuthConfig } = await import('./auth-config')
  return resolveAuthConfig()
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('resolveAuthConfig のメーラー設定', () => {
  it('MAILER_DRIVER=smtp のときだけ smtp ドライバを選ぶ', async () => {
    expect((await resolveWith({ mailerDriver: 'smtp' })).mailer.driver).toBe('smtp')
    expect((await resolveWith({ mailerDriver: 'log' })).mailer.driver).toBe('log')
    expect((await resolveWith({ mailerDriver: '' })).mailer.driver).toBe('log')
    expect((await resolveWith({ mailerDriver: 'sendgrid' })).mailer.driver).toBe('log')
  })

  it('SMTP_* を接続設定のそれぞれのフィールドへ運ぶ', async () => {
    const config = await resolveWith({
      smtpHost: 'smtp.example.test',
      smtpPort: '465',
      smtpSecure: '1',
      smtpUser: 'relay-user',
      smtpPassword: 'relay-password',
    })

    expect(config.mailer.smtp).toStrictEqual({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      user: 'relay-user',
      pass: 'relay-password',
    })
  })

  it('SMTP_SECURE が "1" 以外なら STARTTLS 側(secure=false)にする', async () => {
    expect((await resolveWith({ smtpSecure: '' })).mailer.smtp?.secure).toBe(false)
    expect((await resolveWith({ smtpSecure: 'true' })).mailer.smtp?.secure).toBe(false)
  })

  it('SMTP_PORT が数でないときは 587 にする', async () => {
    expect((await resolveWith({ smtpPort: '' })).mailer.smtp?.port).toBe(587)
    expect((await resolveWith({ smtpPort: 'あ' })).mailer.smtp?.port).toBe(587)
  })

  it('MAIL_FROM が空なら noreply@localhost にする', async () => {
    expect((await resolveWith({ mailFrom: '' })).mailer.from).toBe('noreply@localhost')
  })
})
