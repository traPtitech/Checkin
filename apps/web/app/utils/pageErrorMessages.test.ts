import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ORPCError } from '@orpc/client'
import { describe, expect, it } from 'vitest'
import { createErrorMessageFor } from './errorMessage'
import type { ErrorMessageSpec } from './errorMessage'
import {
  membershipErrorMessages,
  paymentsErrorMessages,
  payoutsErrorMessages,
  specialInvoiceErrorMessages,
} from './pageErrorMessages'

/**
 * The four pages that show an `$orpc` failure each carried a private
 * `errorMessageFor`. They now share `createErrorMessageFor`, and the text they
 * show must be unchanged. Every expected string below was produced by running
 * the previous implementations, read from `git show b33362c:<page>`.
 *
 * These cases run the exported specs the pages actually use, so a change to a
 * page's wording or to which code it covers fails here.
 */
const PAGES = ['membership', 'payments', 'payouts', 'special-invoice'] as const
type Page = typeof PAGES[number]

const specs: Record<Page, { spec: ErrorMessageSpec, specName: string }> = {
  'membership': { spec: membershipErrorMessages, specName: 'membershipErrorMessages' },
  'payments': { spec: paymentsErrorMessages, specName: 'paymentsErrorMessages' },
  'payouts': { spec: payoutsErrorMessages, specName: 'payoutsErrorMessages' },
  'special-invoice': { spec: specialInvoiceErrorMessages, specName: 'specialInvoiceErrorMessages' },
}

const ACCOUNTANT_SESSION = '会計セッションが必要です。会計でログインしてください。'
const CONFLICT_MESSAGE = '既に支払い済みです。'

/** The value caught in a page's `catch`, and the text each page showed for it. */
const cases: { input: string, caught: () => unknown, shown: Record<Page, string> }[] = [
  {
    input: 'an ORPCError with code UNAUTHORIZED',
    caught: () => new ORPCError('UNAUTHORIZED'),
    shown: {
      'membership': '発行に失敗しました。時間をおいて再度お試しください。',
      'payments': ACCOUNTANT_SESSION,
      'payouts': ACCOUNTANT_SESSION,
      'special-invoice': ACCOUNTANT_SESSION,
    },
  },
  {
    input: 'an ORPCError with code FORBIDDEN',
    caught: () => new ORPCError('FORBIDDEN'),
    shown: {
      'membership': '確認したメールと一致しません。確認時と同じメールアドレスを入力してください。',
      'payments': ACCOUNTANT_SESSION,
      'payouts': ACCOUNTANT_SESSION,
      'special-invoice': ACCOUNTANT_SESSION,
    },
  },
  {
    input: 'an ORPCError with code CONFLICT carrying a message',
    caught: () => new ORPCError('CONFLICT', { message: CONFLICT_MESSAGE }),
    shown: {
      'membership': '発行に失敗しました。時間をおいて再度お試しください。',
      'payments': '一覧の取得に失敗しました。Stripe の設定や接続状況をご確認ください。',
      'payouts': '操作に失敗しました。Jomon／Stripe の接続状況をご確認ください。',
      'special-invoice': CONFLICT_MESSAGE,
    },
  },
  {
    input: 'an ORPCError with code CONFLICT and no message',
    // @orpc/client 1.15.1 fills in a default message for a known code, so
    // `/special-invoice` passes `Conflict` through rather than an empty string.
    // Measured, not documented behaviour, so the version is named here.
    caught: () => new ORPCError('CONFLICT'),
    shown: {
      'membership': '発行に失敗しました。時間をおいて再度お試しください。',
      'payments': '一覧の取得に失敗しました。Stripe の設定や接続状況をご確認ください。',
      'payouts': '操作に失敗しました。Jomon／Stripe の接続状況をご確認ください。',
      'special-invoice': 'Conflict',
    },
  },
  {
    input: 'an ORPCError with code BAD_REQUEST',
    caught: () => new ORPCError('BAD_REQUEST'),
    shown: {
      'membership': '発行に失敗しました。時間をおいて再度お試しください。',
      'payments': '一覧の取得に失敗しました。Stripe の設定や接続状況をご確認ください。',
      'payouts': '操作に失敗しました。Jomon／Stripe の接続状況をご確認ください。',
      'special-invoice': 'メールアドレスをご確認ください（許可されたドメイン宛である必要があります）。設定不備の可能性もあります。',
    },
  },
  {
    input: 'an ORPCError with code INTERNAL_SERVER_ERROR',
    caught: () => new ORPCError('INTERNAL_SERVER_ERROR'),
    shown: {
      'membership': '発行に失敗しました。時間をおいて再度お試しください。',
      'payments': '一覧の取得に失敗しました。Stripe の設定や接続状況をご確認ください。',
      'payouts': '操作に失敗しました。Jomon／Stripe の接続状況をご確認ください。',
      'special-invoice': '発行に失敗しました。時間をおいて再度お試しください。',
    },
  },
  {
    input: 'a plain Error',
    caught: () => new Error('x'),
    shown: {
      'membership': '発行に失敗しました。時間をおいて再度お試しください。',
      'payments': '一覧の取得に失敗しました。時間をおいて再度お試しください。',
      'payouts': '操作に失敗しました。時間をおいて再度お試しください。',
      'special-invoice': '発行に失敗しました。時間をおいて再度お試しください。',
    },
  },
  {
    input: 'a thrown string',
    caught: () => 'x',
    shown: {
      'membership': '発行に失敗しました。時間をおいて再度お試しください。',
      'payments': '一覧の取得に失敗しました。時間をおいて再度お試しください。',
      'payouts': '操作に失敗しました。時間をおいて再度お試しください。',
      'special-invoice': '発行に失敗しました。時間をおいて再度お試しください。',
    },
  },
  {
    input: 'undefined',
    caught: () => undefined,
    shown: {
      'membership': '発行に失敗しました。時間をおいて再度お試しください。',
      'payments': '一覧の取得に失敗しました。時間をおいて再度お試しください。',
      'payouts': '操作に失敗しました。時間をおいて再度お試しください。',
      'special-invoice': '発行に失敗しました。時間をおいて再度お試しください。',
    },
  },
]

describe.each(PAGES)('%s', (page) => {
  const errorMessageFor = createErrorMessageFor(specs[page].spec)

  it.each(cases)('shows the same text as before for $input', ({ caught, shown }) => {
    expect(errorMessageFor(caught())).toBe(shown[page])
  })
})

/**
 * The cases above run the specs, not the pages. This pins the one link they
 * cannot follow — that the page builds its `errorMessageFor` from the spec
 * exercised here — which no import can reach, because a `<script setup>` block
 * cannot contain ES module exports (the version this was measured with is named
 * in the comment on `pageErrorMessages.ts`).
 *
 * It does not check how the page renders the returned text, nor that the page
 * calls `errorMessageFor` on every failure path it has.
 */
describe('page wiring', () => {
  it.each(PAGES)('%s builds errorMessageFor from the spec these cases run', (page) => {
    const source = readFileSync(fileURLToPath(new URL(`../pages/${page}.vue`, import.meta.url)), 'utf8')
    expect(source).toContain(`const errorMessageFor = createErrorMessageFor(${specs[page].specName})`)
  })
})
