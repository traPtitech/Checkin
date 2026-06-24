// run_paid.mjs — Prove the previously-BLOCKED "real payment → ledger paid →
// re-issue rejected" scenarios with actual Stripe test-card charges (tok_visa).
//
// Flow per scenario: issue (UI/API) → grab invoiceId → pay via pay.mjs (tok_visa,
// real charge) → assert Stripe status=paid → POLL re-issue until it returns
// CONFLICT (the webhook is async; until markPaid runs the open invoice is reused
// and re-issue succeeds with the same id). CONFLICT is the proof the ledger slot
// flipped to `paid`. We also grep /tmp/checkin-dev.log for the paid notification.
//
// READ-ONLY w.r.t. app/spec code. Uses a FRESH email per scenario (Stripe
// idempotency-window hygiene). Run from repo root:
//   cd /home/kaitoyama/Checkin && node scripts/e2e/run_paid.mjs
import { launch, newCtx, devLogin, freshEmail, BASE } from './harness.mjs'
import { payInvoice, getInvoice } from './pay.mjs'
import { readFileSync } from 'node:fs'

const DEV_LOG = '/tmp/checkin-dev.log'
const browser = await launch()
const results = []
const log = (...a) => console.log(...a)
const rec = (id, verdict, observed, note = '') => {
  results.push({ id, verdict, observed, note })
  log(`\n[${id}] ${verdict} :: ${observed}${note ? ' // ' + note : ''}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Issue a STANDARD membership invoice via the in-page oRPC envelope.
// feeType ∈ {new, continuation}. Returns {status, invoiceId, code, message}.
async function issueStandard(page, { email, name, feeType }) {
  return page.evaluate(async ({ base, email, name, feeType }) => {
    const m = document.cookie.match(/(?:^|;\s*)__Host-checkin_csrf=([^;]+)/)
    const csrf = m ? m[1] : ''
    const r = await fetch(base + '/rpc/membership/issueInvoice', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ json: { email, name, feeType } }),
    })
    let b; try { b = await r.json() } catch { b = null }
    return { status: r.status, invoiceId: b?.json?.invoiceId, code: b?.json?.code, message: b?.json?.message }
  }, { base: BASE, email, name, feeType })
}

// Issue a SPECIAL (¥2,000, single half) invoice by email (admin).
async function issueSpecial(page, { email, name, coverage, activityYear }) {
  return page.evaluate(async ({ base, email, name, coverage, activityYear }) => {
    const m = document.cookie.match(/(?:^|;\s*)__Host-checkin_csrf=([^;]+)/)
    const csrf = m ? m[1] : ''
    const payload = { email, name, coverage }
    if (activityYear !== undefined) payload.activityYear = activityYear
    const r = await fetch(base + '/rpc/membership/issueSpecialInvoiceByEmail', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ json: payload }),
    })
    let b; try { b = await r.json() } catch { b = null }
    return { status: r.status, invoiceId: b?.json?.invoiceId, code: b?.json?.code, message: b?.json?.message }
  }, { base: BASE, email, name, coverage, activityYear })
}

// Poll a re-issue closure until it returns CONFLICT (409) or timeout (~25s).
// `reissue` is an async () => ({status, code, invoiceId, message}).
// Returns { conflicted, elapsedMs, polls, last }.
async function pollForConflict(reissue, { timeoutMs = 25000, intervalMs = 2000 } = {}) {
  const start = Date.now()
  let polls = 0
  let last = null
  while (Date.now() - start < timeoutMs) {
    polls++
    last = await reissue()
    if (last.status === 409 || last.code === 'CONFLICT') {
      return { conflicted: true, elapsedMs: Date.now() - start, polls, last }
    }
    await sleep(intervalMs)
  }
  return { conflicted: false, elapsedMs: Date.now() - start, polls, last }
}

// Did the dev log gain a paid notification mentioning this Stripe event? We grep
// for the JA notification line; the event id is the invoice's most-recent evt.
function paidNotificationEventIds() {
  let t = ''
  try { t = readFileSync(DEV_LOG, 'utf8') } catch { return [] }
  const ids = []
  const re = /入金を確認しました（Stripe event (evt_[A-Za-z0-9]+)）/g
  let m
  while ((m = re.exec(t)) !== null) ids.push(m[1])
  return ids
}

try {
  // ===========================================================================
  // 横-01: any fresh invoice → card pay → (a) dev-log paid notification fires,
  //        (b) Stripe invoice status=paid, (c) same-condition re-issue → CONFLICT.
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('yoko01')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })

    const notifBefore = paidNotificationEventIds().length
    const issued = await issueStandard(page, { email, name: 'Yoko01', feeType: 'new' })
    const pay = payInvoice(issued.invoiceId)
    const si = getInvoice(issued.invoiceId)

    const poll = await pollForConflict(
      () => issueStandard(page, { email, name: 'Yoko01', feeType: 'new' }),
    )
    await sleep(1500)
    const notifAfter = paidNotificationEventIds()
    const newNotif = notifAfter.length > notifBefore
    const evtId = newNotif ? notifAfter[notifAfter.length - 1] : null

    const ok = pay.status === 'paid' && si.status === 'paid'
      && poll.conflicted && poll.last.message?.includes('既に支払い済み') && newNotif
    rec('横-01', ok ? 'PASS' : 'FAIL',
      `invoiceId=${issued.invoiceId} payMethod=${pay.method} payStatus=${pay.status} charge=${pay.charge || '-'} stripeStatus=${si.status} → re-issue CONFLICT=${poll.conflicted} (after ${poll.polls} polls / ${poll.elapsedMs}ms) code=${poll.last.code} msg="${poll.last.message}" | notifFired=${newNotif} evt=${evtId}`,
      `(a) dev-log 入金確認通知 + (b) Stripe paid + (c) re-issue CONFLICT all observed; charge ¥${pay.amountPaid || '?'}`)
    await ctx.close()
  }

  // ===========================================================================
  // 入-10: as:user (fresh), feeType=new (today zenki ⇒ ¥4,000 通期/full, year 2026)
  //        → card pay → same user re-issue new → CONFLICT 「対象の期間は既に支払い済み」.
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('nyu10')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })

    const issued = await issueStandard(page, { email, name: 'Nyu10', feeType: 'new' })
    const pay = payInvoice(issued.invoiceId)
    const si = getInvoice(issued.invoiceId)
    const md = si?.metadata || {}
    const poll = await pollForConflict(
      () => issueStandard(page, { email, name: 'Nyu10', feeType: 'new' }),
    )
    const ok = pay.status === 'paid' && si.status === 'paid'
      && poll.conflicted && poll.last.message?.includes('既に支払い済み')
    rec('入-10', ok ? 'PASS' : 'FAIL',
      `invoiceId=${issued.invoiceId} amount=¥${pay.amountPaid || si.amount_due} term=${md.term} year=${md.activity_year} payMethod=${pay.method} charge=${pay.charge || '-'} stripeStatus=${si.status} → re-issue status=${poll.last.status} code=${poll.last.code} msg="${poll.last.message}" (polls=${poll.polls}, ${poll.elapsedMs}ms)`,
      'new in zenki ⇒ ¥4,000 通期 (full, year 2026); paid both halves ⇒ re-issue rejected')
    await ctx.close()
  }

  // ===========================================================================
  // 継-05: fresh user, feeType=continuation (¥4,000 通期/full, year 2027) → card pay
  //        → re-issue continuation → CONFLICT.
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('kei05')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })

    const issued = await issueStandard(page, { email, name: 'Kei05', feeType: 'continuation' })
    const pay = payInvoice(issued.invoiceId)
    const si = getInvoice(issued.invoiceId)
    const md = si?.metadata || {}
    const poll = await pollForConflict(
      () => issueStandard(page, { email, name: 'Kei05', feeType: 'continuation' }),
    )
    const ok = pay.status === 'paid' && si.status === 'paid'
      && poll.conflicted && poll.last.message?.includes('既に支払い済み')
    rec('継-05', ok ? 'PASS' : 'FAIL',
      `invoiceId=${issued.invoiceId} amount=¥${pay.amountPaid || si.amount_due} term=${md.term} year=${md.activity_year} payMethod=${pay.method} charge=${pay.charge || '-'} stripeStatus=${si.status} → re-issue status=${poll.last.status} code=${poll.last.code} msg="${poll.last.message}" (polls=${poll.polls}, ${poll.elapsedMs}ms)`,
      'continuation ⇒ ¥4,000 通期 (full, year 2027); paid both halves ⇒ re-issue rejected')
    await ctx.close()
  }

  // ===========================================================================
  // 特-08 + 特-11: as:admin issueSpecialInvoiceByEmail (fresh, coverage=zenki, ¥2,000)
  //        → card pay → (特-11) dev-log paid notification + zenki slot paid
  //        → re-issue same email+coverage=zenki → CONFLICT (特-08); the CONFLICT
  //        being on ZENKI (not kouki) proves the zenki half-slot is paid (特-11).
  // ===========================================================================
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('sp08')
    await devLogin(ctx, { as: 'admin' })
    await page.goto(BASE + '/special-invoice', { waitUntil: 'networkidle' })

    const notifBefore = paidNotificationEventIds().length
    const issued = await issueSpecial(page, { email, name: 'Special08', coverage: 'zenki' })
    const pay = payInvoice(issued.invoiceId)
    const si = getInvoice(issued.invoiceId)
    const md = si?.metadata || {}

    const poll = await pollForConflict(
      () => issueSpecial(page, { email, name: 'Special08', coverage: 'zenki' }),
    )
    await sleep(1500)
    const notifAfter = paidNotificationEventIds()
    const newNotif = notifAfter.length > notifBefore
    const evtId = newNotif ? notifAfter[notifAfter.length - 1] : null

    // Control: kouki must STILL be issuable (proving only the zenki slot is paid,
    // not the whole year) — distinguishes "zenki slot paid" from a blanket lock.
    const koukiCtl = await issueSpecial(page, { email, name: 'Special08K', coverage: 'kouki' })

    const ok08 = pay.status === 'paid' && si.status === 'paid'
      && poll.conflicted && poll.last.message?.includes('既に支払い済み')
    rec('特-08', ok08 ? 'PASS' : 'FAIL',
      `invoiceId=${issued.invoiceId} amount=¥${pay.amountPaid || si.amount_due} variant=${md.variant} coverage=${md.coverage} payMethod=${pay.method} charge=${pay.charge || '-'} stripeStatus=${si.status} → re-issue(zenki) status=${poll.last.status} code=${poll.last.code} msg="${poll.last.message}" (polls=${poll.polls}, ${poll.elapsedMs}ms)`,
      'special zenki paid ⇒ same email+coverage re-issue rejected')

    const ok11 = ok08 && newNotif && (koukiCtl.status === 200 && !!koukiCtl.invoiceId)
    rec('特-11', ok11 ? 'PASS' : 'FAIL',
      `paidNotifFired=${newNotif} evt=${evtId} | zenki re-issue CONFLICT=${poll.conflicted} (zenki slot paid) | kouki control still issuable: status=${koukiCtl.status} invoiceId=${koukiCtl.invoiceId} code=${koukiCtl.code}`,
      'special paid ⇒ THAT half (zenki) flips paid + accountant notified; kouki half remains issuable ⇒ proves per-slot paid, not blanket lock')
    await ctx.close()
  }

  // ===========================================================================
  log('\n\n===== SUMMARY =====')
  log('| ID | 判定 | 観測 |')
  for (const r of results) log(`| ${r.id} | ${r.verdict} | ${r.observed}${r.note ? ' // ' + r.note : ''} |`)
}
catch (e) {
  console.error('RUN FAIL', e.stack)
}
finally {
  await browser.close()
}
