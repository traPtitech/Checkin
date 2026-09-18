/**
 * What each page shows for an `$orpc` failure. This lives here rather than in
 * the pages so that the tests can import it: a `<script setup>` block cannot
 * contain ES module exports at all, so a page cannot hand its wording to a
 * test. Measured with `@vue/compiler-sfc` 3.5.40, which rejects such a block
 * with "<script setup> cannot contain ES module exports". Each page builds its
 * `errorMessageFor` by passing one of these to `createErrorMessageFor`.
 * Auto-imported by Nuxt from `app/utils`.
 *
 * Every spec carries the `ErrorMessageSpec` annotation rather than being left
 * to inference, so that an unknown key written next to valid ones in `byCode`
 * is rejected. Measured with TypeScript 6.0.3: the annotation puts an object
 * literal against the type, which reports `Object literal may only specify
 * known properties`; drop it and the same key is accepted, because the spec
 * then reaches `createErrorMessageFor` as a variable, and assignability alone
 * allows the extra key.
 */
import type { ErrorMessageSpec } from './errorMessage'

const ACCOUNTANT_SESSION_MESSAGE = '会計セッションが必要です。会計でログインしてください。'

/**
 * The authn/authz wording the accountant-only pages share. It is spread in per
 * page rather than built into `createErrorMessageFor`, because `/membership` is
 * member-facing: telling a member to log in as an accountant would be wrong.
 */
const accountantSessionMessages = {
  UNAUTHORIZED: ACCOUNTANT_SESSION_MESSAGE,
  FORBIDDEN: ACCOUNTANT_SESSION_MESSAGE,
}

/** `/membership` — member-facing, so the accountant wording is left out. */
export const membershipErrorMessages: ErrorMessageSpec = {
  byCode: {
    // mail_hash mismatch (FORBIDDEN) — the resubmitted email is not the verified one.
    FORBIDDEN: '確認したメールと一致しません。確認時と同じメールアドレスを入力してください。',
  },
  orpcFallback: '発行に失敗しました。時間をおいて再度お試しください。',
  otherFallback: '発行に失敗しました。時間をおいて再度お試しください。',
}

/** `/payments` — the accountant's invoice and checkout-session lists. */
export const paymentsErrorMessages: ErrorMessageSpec = {
  byCode: { ...accountantSessionMessages },
  orpcFallback: '一覧の取得に失敗しました。Stripe の設定や接続状況をご確認ください。',
  otherFallback: '一覧の取得に失敗しました。時間をおいて再度お試しください。',
}

/** `/payouts` — the accountant's payout list and its per-row operations. */
export const payoutsErrorMessages: ErrorMessageSpec = {
  byCode: { ...accountantSessionMessages },
  orpcFallback: '操作に失敗しました。Jomon／Stripe の接続状況をご確認ください。',
  otherFallback: '操作に失敗しました。時間をおいて再度お試しください。',
}

/** `/special-invoice` — the accountant's ¥2,000 special invoice form. */
export const specialInvoiceErrorMessages: ErrorMessageSpec = {
  byCode: {
    ...accountantSessionMessages,
    // CONFLICT / BAD_REQUEST carry a user-facing JA message from the API
    // (既に支払い済み・期間重複／ドメイン不可・メール不一致・設定エラー).
    // Only CONFLICT is passed through; BAD_REQUEST gets a fixed wording.
    CONFLICT: error => error.message,
    BAD_REQUEST: 'メールアドレスをご確認ください（許可されたドメイン宛である必要があります）。設定不備の可能性もあります。',
  },
  orpcFallback: '発行に失敗しました。時間をおいて再度お試しください。',
  otherFallback: '発行に失敗しました。時間をおいて再度お試しください。',
}
