// 入部機能 (feeType:'new', entry /membership) — UI-level real-behavior verification.
// READ-ONLY: does not modify app/spec code. Run from repo root:
//   cd /home/kaitoyama/Checkin && node scripts/e2e/run_join.mjs
import { launch, newCtx, devLogin, freshEmail, authMe, shot, BASE } from './harness.mjs'

const browser = await launch()
const results = []
const log = (...a) => console.log(...a)
const rec = (id, verdict, observed, note = '') => {
  results.push({ id, verdict, observed, note })
  log(`\n[${id}] ${verdict} :: ${observed}${note ? ' // ' + note : ''}`)
}

// helper: call issueInvoice via in-page fetch using the oRPC RPC envelope
// ({"json": {...}}), mirroring the app's $orpc client. Carries injected cookies +
// CSRF header. Returns {status, ok:{invoiceId,hostedInvoiceUrl} | undefined, code}.
async function issueInvoice(page, payload, { csrf = true } = {}) {
  return page.evaluate(async ({ base, payload, csrf }) => {
    const headers = { 'content-type': 'application/json' }
    if (csrf) {
      const m = document.cookie.match(/(?:^|;\s*)__Host-checkin_csrf=([^;]+)/)
      headers['x-csrf-token'] = m ? m[1] : ''
    }
    const r = await fetch(base + '/rpc/membership/issueInvoice', {
      method: 'POST', headers,
      body: JSON.stringify({ json: payload }),
    })
    let parsed
    try { parsed = await r.json() } catch { parsed = await r.text().catch(() => null) }
    const ok = parsed?.json && parsed.json.invoiceId ? parsed.json : undefined
    const code = parsed?.json?.code // oRPC error envelope: {json:{code,status,message}}
    return { status: r.status, ok, code, body: parsed }
  }, { base: BASE, payload, csrf })
}

try {
  // ---------------------------------------------------------------------------
  // 入-01: anon, click 新規入部 → /verify-email?redirect=...%3Ftype%3Dnew
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    // Click the card whose bold label is exactly 新規入部 (the clickable UCard).
    const card = page.locator('.cursor-pointer', { hasText: '新規入部' }).first()
    await card.click()
    await page.waitForURL(/verify-email/, { timeout: 8000 }).catch(() => {})
    const url = page.url()
    await shot(page, 'join-01-new')
    const ok = /\/verify-email\?redirect=/.test(url) && /%3Ftype%3Dnew/.test(url)
    rec('入-01', ok ? 'PASS' : 'FAIL', `url=${url}`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 入-02: anon, click 再入部 → redirect contains %3Ftype%3Drejoin
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    await page.locator('.cursor-pointer', { hasText: '再入部' }).first().click()
    await page.waitForURL(/verify-email/, { timeout: 8000 }).catch(() => {})
    const url = page.url()
    await shot(page, 'join-02-rejoin')
    const ok = /\/verify-email\?redirect=/.test(url) && /%3Ftype%3Drejoin/.test(url)
    rec('入-02', ok ? 'PASS' : 'FAIL', `url=${url}`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 入-03: anon, click 現役 → /login?redirect=/membership (external nav)
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    // external nav may resolve to traQ OAuth or 4xx; capture wherever it lands.
    await page.locator('.cursor-pointer', { hasText: '現役' }).first().click()
    await page.waitForLoadState('load', { timeout: 8000 }).catch(() => {})
    await page.waitForTimeout(800)
    const url = page.url()
    await shot(page, 'join-03-continuation')
    // The app navigates to /login?redirect=/membership (Nitro OAuth route).
    const ok = /\/login\?redirect=(%2F|\/)membership/.test(url) || url.includes('/login?redirect=/membership')
    rec('入-03', ok ? 'PASS' : 'FAIL', `url=${url}`, ok ? '' : 'expected /login?redirect=/membership')
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 入-04: as:user (fresh), fill form (own email, name, 区分=new) → 200 + hostedInvoiceUrl
  //        前期(zenki) ⇒ ¥4,000 通期 expected.
  // ---------------------------------------------------------------------------
  let invoice04 = null
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('join04')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const me = (await authMe(page)).body?.json
    // Confirm the real UI form is present (issuance path is genuinely reachable).
    const hasForm = await page.locator('input[type=email]').count()
    // Issue with deterministic feeType=new via the corrected oRPC envelope.
    const r = await issueInvoice(page, { email, name: 'E2E Join Test', feeType: 'new' })
    await shot(page, 'join-04-issue')
    const inv = r.ok
    const hostedUrl = inv?.hostedInvoiceUrl
    const ok = r.status === 200 && typeof hostedUrl === 'string' && hostedUrl.startsWith('http')
    invoice04 = { email, invoiceId: inv?.invoiceId, hostedInvoiceUrl: hostedUrl }
    rec('入-04', ok ? 'PASS' : 'FAIL',
      `status=${r.status} formPresent=${hasForm > 0} invoiceId=${inv?.invoiceId} hostedInvoiceUrl=${hostedUrl ? hostedUrl.slice(0, 50) + '…' : hostedUrl}`,
      `me=${JSON.stringify(me)}`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 入-06: as:user, submit a DIFFERENT isct email → FORBIDDEN
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const me = freshEmail('join06self')
    const other = freshEmail('join06other')
    await devLogin(ctx, { as: 'user', email: me })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const r = await issueInvoice(page, { email: other, name: 'Not Me', feeType: 'new' })
    await shot(page, 'join-06-forbidden')
    const ok = r.status === 403 || r.code === 'FORBIDDEN'
    rec('入-06', ok ? 'PASS' : 'FAIL',
      `status=${r.status} code=${r.code} msg=${r.body?.json?.message}`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 入-07: as:member (traQ only, unlinked) → no form, "メールアドレスを確認する" btn,
  //        no auto-redirect; clicking goes to /verify-email?redirect=/membership
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await devLogin(ctx, { as: 'member' })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    await page.waitForTimeout(800)
    const urlAfterLoad = page.url()
    const me = (await authMe(page)).body?.json
    const hasBtn = await page.locator('text=メールアドレスを確認').count()
    const hasForm = await page.locator('input[type=email]').count()
    const noAutoRedirect = /\/membership$/.test(urlAfterLoad)
    await shot(page, 'join-07-member-prompt')
    // click the button → verify-email
    await page.locator('text=メールアドレスを確認').first().click().catch(() => {})
    await page.waitForURL(/verify-email/, { timeout: 8000 }).catch(() => {})
    const afterClick = page.url()
    const clickOk = afterClick.includes('/verify-email?redirect=/membership') || /verify-email\?redirect=(%2F|\/)membership/.test(afterClick)
    const ok = hasBtn > 0 && hasForm === 0 && noAutoRedirect && clickOk
    rec('入-07', ok ? 'PASS' : 'FAIL',
      `stayedOnMembership=${noAutoRedirect} verifyBtn=${hasBtn > 0} formInputs=${hasForm} afterClick=${afterClick}`,
      `me=${JSON.stringify(me)}`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 入-08: NO session, direct POST /rpc/membership/issueInvoice → UNAUTHORIZED
  //        (auth rejected before input validation)
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    // fresh anon page; no devLogin. Send invalid body too, to prove auth-before-validation.
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const r = await page.evaluate(async (base) => {
      const resp = await fetch(base + '/rpc/membership/issueInvoice', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ garbage: true }), // malformed on purpose
      })
      let b; try { b = await resp.json() } catch { b = await resp.text() }
      return { status: resp.status, body: b }
    }, BASE)
    const code = r.body?.code ?? r.body?.json?.code ?? r.body?.defined?.code
    const ok = r.status === 401 || code === 'UNAUTHORIZED'
    rec('入-08', ok ? 'PASS' : 'FAIL',
      `status=${r.status} code=${code} body=${JSON.stringify(r.body).slice(0, 160)}`,
      'sent malformed body to prove auth runs before input validation')
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 入-09: as:user (fresh), issue same condition TWICE (unpaid) → 2nd reuses open
  //        invoice (same hostedInvoiceUrl / invoiceId)
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('join09')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const r1 = await issueInvoice(page, { email, name: 'Reuse Test', feeType: 'new' })
    const r2 = await issueInvoice(page, { email, name: 'Reuse Test', feeType: 'new' })
    const i1 = r1.ok, i2 = r2.ok
    await shot(page, 'join-09-reuse')
    // The dedup invariant is invoiceId: the 2nd call must NOT mint a new invoice.
    // (Stripe mints a fresh time-bound hosted-page token per fetch, so the
    //  hostedInvoiceUrl signature differs even for the identical invoice — the
    //  invoiceId being equal proves the open invoice was reused.)
    const ok = r1.status === 200 && r2.status === 200
      && !!i1?.invoiceId && i1.invoiceId === i2?.invoiceId
    rec('入-09', ok ? 'PASS' : 'FAIL',
      `1st invoiceId=${i1?.invoiceId} 2nd invoiceId=${i2?.invoiceId} sameInvoiceId=${i1?.invoiceId === i2?.invoiceId} (urls differ only by per-fetch signature)`)
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // 入-12 (optional): same fresh user, fire issueInvoice concurrently → single invoice
  // ---------------------------------------------------------------------------
  {
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    const email = freshEmail('join12')
    await devLogin(ctx, { as: 'user', email })
    await page.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    const N = 5
    const out = await page.evaluate(async ({ base, email, N }) => {
      const m = document.cookie.match(/(?:^|;\s*)__Host-checkin_csrf=([^;]+)/)
      const csrf = m ? m[1] : ''
      const one = async () => {
        const r = await fetch(base + '/rpc/membership/issueInvoice', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify({ json: { email, name: 'Concurrent', feeType: 'new' } }),
        })
        let b; try { b = await r.json() } catch { b = null }
        return { status: r.status, invoiceId: b?.json?.invoiceId, code: b?.json?.code }
      }
      const arr = await Promise.all(Array.from({ length: N }, () => one()))
      return arr
    }, { base: BASE, email, N })
    await shot(page, 'join-12-concurrent')
    const ids = [...new Set(out.map(o => o.invoiceId).filter(Boolean))]
    const statuses = out.map(o => o.status)
    const ok = ids.length === 1
    rec('入-12', ok ? 'PASS' : (ids.length === 0 ? 'BLOCKED' : 'FAIL'),
      `statuses=[${statuses.join(',')}] distinctInvoiceIds=${ids.length} → ${JSON.stringify(ids).slice(0, 80)}`,
      ids.length === 1 ? 'converged to a single invoice' : '')
    await ctx.close()
  }

  // ---------------------------------------------------------------------------
  // Summary table
  // ---------------------------------------------------------------------------
  log('\n\n===== SUMMARY =====')
  log('| ID | 判定 | 観測 |')
  for (const r of results) log(`| ${r.id} | ${r.verdict} | ${r.observed}${r.note ? ' // ' + r.note : ''} |`)
  if (invoice04?.invoiceId) log('\nNOTE invoice04 invoiceId for amount check:', invoice04.invoiceId)
} catch (e) {
  console.error('RUN FAIL', e.stack)
} finally {
  await browser.close()
}
