// pay.mjs — Pay a finalized (open, send_invoice) Stripe invoice in TEST mode.
//
// Strategy (per the task brief):
//   1. GET /v1/invoices/{id} → grab `customer` (cus_…) and assert open/send_invoice.
//   2. POST /v1/payment_methods  type=card  card[token]=tok_visa  → pm_… (4242 Visa).
//   3. POST /v1/payment_methods/{pm}/attach  customer={cus}.
//   4. POST /v1/invoices/{id}/pay  payment_method={pm}  off_session=true → paid.
//   If the card path errors, FALL BACK to paid_out_of_band=true (no charge, but
//   invoice.paid still fires) and flag which path was used.
//
// READ-ONLY w.r.t. app/spec code. Run standalone:  node scripts/e2e/pay.mjs inv_123
// Or import { payInvoice } from './pay.mjs'.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

function envVal(key) {
  const t = readFileSync('/home/kaitoyama/Checkin/.env', 'utf8')
  const m = t.match(new RegExp('^' + key + '=(.*)$', 'm'))
  return m ? m[1].replace(/^['"]|['"]$/g, '') : ''
}
const STRIPE_SECRET_KEY = envVal('STRIPE_SECRET_KEY')

// Low-level Stripe REST call via curl. `form` is an array of "k=v" strings.
// method: 'GET' | 'POST'. Returns parsed JSON (or {_raw} on parse failure).
function stripe(method, path, form = []) {
  const args = ['-s', '-X', method, `https://api.stripe.com/v1/${path}`,
    '-u', `${STRIPE_SECRET_KEY}:`]
  for (const f of form) { args.push('-d', f) }
  const out = execFileSync('curl', args, { encoding: 'utf8' })
  try { return JSON.parse(out) }
  catch { return { _raw: out.slice(0, 400) } }
}

export function getInvoice(invoiceId) {
  return stripe('GET', `invoices/${invoiceId}`)
}

/**
 * Pay an open/send_invoice invoice with the test Visa (tok_visa). Falls back to
 * paid_out_of_band if the card path errors. Returns:
 *   { method: 'card'|'out_of_band'|'already_paid'|'error',
 *     status, invoiceId, customer, paymentMethod?, charge?, error?, invoice }
 */
export function payInvoice(invoiceId) {
  const inv = getInvoice(invoiceId)
  if (!inv || inv.error || !inv.id) {
    return { method: 'error', status: null, invoiceId, error: inv?.error?.message || inv?._raw || 'invoice fetch failed', invoice: inv }
  }
  if (inv.status === 'paid') {
    return { method: 'already_paid', status: 'paid', invoiceId, customer: inv.customer, invoice: inv }
  }
  const customer = inv.customer
  if (!customer) {
    return { method: 'error', status: inv.status, invoiceId, error: 'invoice has no customer', invoice: inv }
  }

  // --- Card path (tok_visa → 4242, no 3DS) -----------------------------------
  let cardError = null
  try {
    const pm = stripe('POST', 'payment_methods', ['type=card', 'card[token]=tok_visa'])
    if (pm.error || !pm.id) { throw new Error('pm create: ' + (pm.error?.message || JSON.stringify(pm).slice(0, 160))) }

    const attach = stripe('POST', `payment_methods/${pm.id}/attach`, [`customer=${customer}`])
    if (attach.error) { throw new Error('attach: ' + attach.error.message) }

    const paid = stripe('POST', `invoices/${invoiceId}/pay`, [`payment_method=${pm.id}`, 'off_session=true'])
    if (paid.error || paid.status !== 'paid') {
      throw new Error('pay: ' + (paid.error?.message || `status=${paid.status}`))
    }
    return {
      method: 'card', status: paid.status, invoiceId, customer,
      paymentMethod: pm.id, charge: paid.charge, amountPaid: paid.amount_paid,
      currency: paid.currency, invoice: paid,
    }
  }
  catch (e) {
    cardError = e.message
  }

  // --- Fallback: paid_out_of_band (no charge, invoice.paid still fires) -------
  const oob = stripe('POST', `invoices/${invoiceId}/pay`, ['paid_out_of_band=true'])
  if (oob.error || oob.status !== 'paid') {
    return {
      method: 'error', status: oob.status, invoiceId, customer,
      error: `card path failed (${cardError}); out_of_band also failed: ${oob.error?.message || oob.status}`,
      invoice: oob,
    }
  }
  return {
    method: 'out_of_band', status: oob.status, invoiceId, customer,
    cardError, amountPaid: oob.amount_paid, currency: oob.currency, invoice: oob,
  }
}

// CLI: node scripts/e2e/pay.mjs <invoiceId>
if (import.meta.url === `file://${process.argv[1]}`) {
  const id = process.argv[2]
  if (!id) { console.error('usage: node pay.mjs <invoiceId>'); process.exit(1) }
  const r = payInvoice(id)
  console.log(JSON.stringify({
    method: r.method, status: r.status, invoiceId: r.invoiceId,
    customer: r.customer, paymentMethod: r.paymentMethod, charge: r.charge,
    amountPaid: r.amountPaid, currency: r.currency, error: r.error, cardError: r.cardError,
  }, null, 2))
}
