import type { H3Event } from 'h3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StripeClient } from '@checkin/api'
import { buildRequestContext } from './auth'
import { resolveAuthConfig } from './auth-config'
import { resolveBillingConfig } from './billing-config'
import { resolveJomonConfig } from './jomon-config'

/**
 * `buildRequestContext` reaches its inputs through Nitro auto-imports. Outside a
 * Nuxt build those are plain free identifiers resolved against the global scope,
 * so the test installs each one on the global object. `resolve*Config` get their
 * real implementations (they only read `useRuntimeConfig()`); `useDatabase`,
 * `getCookie` and `getHeader` get stubs, because a context built from a
 * cookie-less request never touches the session table.
 */
function stubNitroGlobals(config: Record<string, unknown>): void {
  vi.stubGlobal('useRuntimeConfig', () => config)
  vi.stubGlobal('useDatabase', () => databaseStub)
  vi.stubGlobal('resolveAuthConfig', resolveAuthConfig)
  vi.stubGlobal('resolveBillingConfig', resolveBillingConfig)
  vi.stubGlobal('resolveJomonConfig', resolveJomonConfig)
  vi.stubGlobal('getCookie', () => undefined)
  vi.stubGlobal('getHeader', () => undefined)
}

/** Stands in for the Drizzle handle; no query runs without a session cookie. */
const databaseStub = {}

/**
 * The runtime config of a server that has no Stripe key and no traQ credentials
 * — the "local auth-only dev" shape the lazy Stripe adapter exists for.
 * `enableUnsafeMutations` is the only field the tests below vary.
 */
function runtimeConfig(enableUnsafeMutations: boolean): Record<string, unknown> {
  return {
    databaseUrl: '',
    mailHashSecret: 'test-mail-hash-secret',
    allowedEmailDomains: 'm.isct.ac.jp',
    appOrigin: 'http://localhost:3000',
    emailVerificationTtlSec: '1800',
    sessionTtlSec: '2592000',
    accountantTraqIds: '',
    trustForwardAuth: '',
    mailerDriver: 'log',
    mailFrom: 'noreply@localhost',
    stripeSecretKey: '',
    jomonApiVersion: 'stub',
    payoutCurrency: 'jpy',
    enableUnsafeMutations,
  }
}

/**
 * Stands in for the request event. `buildRequestContext` only forwards it to
 * `getCookie` and `getHeader`, both stubbed above, so no member of it is read.
 * `Object.create(null)` keeps the stub free of inherited members, so a future
 * read of a real `H3Event` member throws instead of silently resolving.
 */
function eventStub(): H3Event {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- H3Event is a class, so no structural literal satisfies it; nothing reads a member of this stub.
  const event: H3Event = Object.create(null)
  return event
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildRequestContext', () => {
  it('carries enableUnsafeMutations=true into Context.mutationsEnabled', async () => {
    stubNitroGlobals(runtimeConfig(true))

    const context = await buildRequestContext(eventStub())

    expect(context.mutationsEnabled).toBe(true)
  })

  it('carries enableUnsafeMutations=false into Context.mutationsEnabled', async () => {
    stubNitroGlobals(runtimeConfig(false))

    const context = await buildRequestContext(eventStub())

    expect(context.mutationsEnabled).toBe(false)
  })

  it('puts a lazy StripeClient on the Context even without a Stripe key', async () => {
    stubNitroGlobals(runtimeConfig(false))

    const context = await buildRequestContext(eventStub())

    expect(context.stripe).toBeInstanceOf(StripeClient)
    // Lazy: building the Context succeeded above; the missing key only surfaces
    // when a procedure actually reaches for the SDK.
    expect(() => context.stripe.sdk).toThrow(/STRIPE_SECRET_KEY/)
  })
})
