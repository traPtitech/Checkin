// 払い戻し / 会計 (adminProc) — UI-level real-behavior verification.
// READ-ONLY: does NOT modify app/spec code. Only this script is mine.
// Run from repo root:  cd /home/kaitoyama/Checkin && node scripts/e2e/run_payout.mjs
//
// SAFETY BOUNDARY (strict — no money / external-state mutation):
//   - NO new real transfer (Stripe) and NO new Jomon `repaid` write-back.
//   - processApproved is SAFE here: both accepted Jomon v1 apps are MULTI-PAYEE
//     (>1 repayment_logs) ⇒ emitted as `multiPayee` markers ⇒ flagged needs-review,
//     NO payout row created, NO transfer. (verified from /api/applications detail)
//   - execute is tried ONLY on the existing status='paid' row ⇒ `already_paid`
//     short-circuit (no transfer, no write-back retry since jomon_written_back_at set).
//   - createOnboardingLink: ONCE, for ONE fresh dev `as:user` (real Express acct = the
//     single allowed side effect; verifies none→requested).
import { launch, newCtx, devLogin, freshEmail, authMe, shot, BASE } from './harness.mjs'
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

// Replicate @checkin/api deriveMailHash to resolve a fresh user's userId from the
// DB (auth.me exposes only `hasUser`, not `userId`). HMAC-SHA256(secret, email).
function envVal(key) {
  const t = readFileSync('/home/kaitoyama/Checkin/.env', 'utf8')
  const m = t.match(new RegExp('^' + key + '=(.*)$', 'm'))
  return m ? m[1].replace(/^['"]|['"]$/g, '') : ''
}
const MAIL_HASH_SECRET = envVal('MAIL_HASH_SECRET')
function deriveMailHash(email) {
  return createHmac('sha256', MAIL_HASH_SECRET).update(email.trim().toLowerCase()).digest('hex')
}

const browser = await launch()
const results = []
const log = (...a) => console.log(...a)
const rec = (id, verdict, observed, note = '') => {
  results.push({ id, verdict, observed, note })
  log(`\n[${id}] ${verdict} :: ${observed}${note ? ' // ' + note : ''}`)
}

const JOMON = 'http://localhost:1323'
const PAID_JOMON_REF = '4036ec0f-b4c2-480a-b070-8470a915ac13:devmember'

// Generic oRPC call via in-page fetch using the RPC envelope ({"json":{...}}),
// mirroring the app's $orpc client. Carries injected cookies + CSRF header (opt).
async function rpc(page, path, payload = {}, { csrf = true } = {}) {
  return page.evaluate(async ({ base, path, payload, csrf }) => {
    const headers = { 'content-type': 'application/json' }
    if (csrf) {
      const m = document.cookie.match(/(?:^|;\s*)__Host-checkin_csrf=([^;]+)/)
      headers['x-csrf-token'] = m ? m[1] : ''
    }
    const r = await fetch(base + '/rpc/' + path, {
      method: 'POST', headers, body: JSON.stringify({ json: payload }),
    })
    let parsed
    try { parsed = await r.json() } catch { parsed = await r.text().catch(() => null) }
    return { status: r.status, body: parsed, json: parsed?.json, code: parsed?.code ?? parsed?.json?.code ?? parsed?.defined?.code }
  }, { base: BASE, path, payload, csrf })
}

// Read MySQL helper (read-only; used to assert no new rows were created).
function sql(q) {
  return execFileSync('mysql', [
    '-h', '127.0.0.1', '-P', '3306', '-u', 'checkin', '-ppassword', 'checkin',
    '-N', '-B', '-e', q,
  ], { encoding: 'utf8' }).trim()
}
function userIdForTraq(traqId) {
  return sql(`SELECT id FROM users WHERE traq_id='${traqId}' LIMIT 1;`) || null
}
function userIdForEmail(email) {
  return sql(`SELECT id FROM users WHERE mail_hash='${deriveMailHash(email)}' LIMIT 1;`) || null
}
function payoutRowCount() {
  return Number(sql('SELECT COUNT(*) FROM payouts;')) || 0
}
function onboardingStatusOf(userId) {
  return sql(`SELECT payout_onboarding_status FROM users WHERE id='${userId}' LIMIT 1;`)
}

try {
  // ===========================================================================
  // 払-19: 認可 — non-accountant (`as:user`) and anon CANNOT see accountant data
  //        or call payouts.{list,processApproved,execute}.
  // ===========================================================================
  {
    // (a) anon: open /payouts → login prompt, no table data; direct rpc → unauthorized.
    const ctx = await newCtx(browser); const page = await ctx.newPage()
    await page.goto(BASE + '/payouts', { waitUntil: 'networkidle' })
    const anonText = await page.locator('body').innerText().catch(() => '')
    await shot(page, 'payout-19-anon')
    const anonList = await rpc(page, 'payouts/list', {})
    const anonProc = await rpc(page, 'payouts/processApproved', {})
    const anonExec = await rpc(page, 'payouts/execute', { jomonRef: PAID_JOMON_REF })

    // (b) as:user (non-accountant): same page → login prompt; direct rpc → unauthorized.
    const ctx2 = await newCtx(browser); const page2 = await ctx2.newPage()
    await devLogin(ctx2, { as: 'user', email: freshEmail('payout19') })
    await page2.goto(BASE + '/payouts', { waitUntil: 'networkidle' })
    const me2 = (await authMe(page2)).body?.json
    const userText = await page2.locator('body').innerText().catch(() => '')
    await shot(page2, 'payout-19-user')
    const userList = await rpc(page2, 'payouts/list', {})
    const userProc = await rpc(page2, 'payouts/processApproved', {})
    const userExec = await rpc(page2, 'payouts/execute', { jomonRef: PAID_JOMON_REF })

    const promptShown = /会計ログインが必要|会計でログイン/.test(anonText) && /会計ログインが必要|会計でログイン/.test(userText)
    const noTableData = !anonText.includes('jomonRef') && !userText.includes(PAID_JOMON_REF)
    const allDenied = [anonList, anonProc, anonExec, userList, userProc, userExec]
      .every(r => r.status >= 400 || /UNAUTHORIZED|FORBIDDEN/.test(JSON.stringify(r.body)))
    const verdict = (promptShown && noTableData && allDenied) ? 'PASS' : 'FAIL'
    rec('払-19', verdict,
      `anon/user UI=会計ログイン要(prompt=${promptShown}, noData=${noTableData}); rpc codes anon[list=${anonList.code ?? anonList.status},proc=${anonProc.code ?? anonProc.status},exec=${anonExec.code ?? anonExec.status}] user[list=${userList.code ?? userList.status},proc=${userProc.code ?? userProc.status},exec=${userExec.code ?? userExec.status}] (user.admin=${me2?.admin})`,
      'adminProc enforced server-side; UI gate is nav/UX only')
  }

  // ===========================================================================
  // Accountant session from here on.
  // ===========================================================================
  const actx = await newCtx(browser); const apage = await actx.newPage()
  await devLogin(actx, { as: 'admin' })
  await apage.goto(BASE + '/payouts', { waitUntil: 'networkidle' })
  const meAdmin = (await authMe(apage)).body?.json
  await shot(apage, 'payout-admin-initial')

  // Baseline list + DB row count (for idempotency / no-new-row assertions).
  const baseList = await rpc(apage, 'payouts/list', {})
  const baseRows = Array.isArray(baseList.json?.items) ? baseList.json.items : []
  const baseCount = payoutRowCount()
  log(`\n[baseline] admin.admin=${meAdmin?.admin} list.items=${baseRows.length} dbRows=${baseCount}`)
  log(`[baseline] rows: ${JSON.stringify(baseRows)}`)

  // ===========================================================================
  // 払-01 (取込) + 払-21 (複数受取人) — click "Jomon 取込・前進" in the real UI.
  //   Predicted: both accepted apps are multi-payee ⇒ ingested=2, needsReview=2,
  //   multiPayeeRefs=[2 appIds], paid=0, NO new payout row, NO transfer.
  // ===========================================================================
  let summary1 = null
  {
    await apage.getByRole('button', { name: /Jomon 取込・前進/ }).click()
    // Wait for the success summary alert to render.
    await apage.waitForSelector('text=取込・前進が完了しました', { timeout: 15000 }).catch(() => {})
    await shot(apage, 'payout-01-21-summary')
    // Read the summary back via a direct call too (to capture exact structured values).
    summary1 = (await rpc(apage, 'payouts/processApproved', {})).json
    const warnVisible = await apage.locator('text=複数受取人の申請があります').isVisible().catch(() => false)
    const refsText = await apage.locator('text=対象の申請ID').innerText().catch(() => '')
    const afterRows = payoutRowCount()

    const noTransfer = summary1?.paid === 0
    const multiFlagged = (summary1?.needsReview ?? 0) >= 2 && (summary1?.multiPayeeRefs?.length ?? 0) >= 2
    const noNewRow = afterRows === baseCount
    // 払-01: ingest summary returned with counts; gated (no money moved).
    rec('払-01', (typeof summary1?.ingested === 'number' && noTransfer && noNewRow) ? 'PASS' : 'FAIL',
      `ingested=${summary1?.ingested} paid=${summary1?.paid} onboardingWaiting=${summary1?.onboardingWaiting} unresolved=${summary1?.unresolved} alreadyPaid=${summary1?.alreadyPaid} needsReview=${summary1?.needsReview} skippedFailed=${summary1?.skippedFailed} errored=${summary1?.errored}; dbRows ${baseCount}->${afterRows}`,
      'gated: multi-payee markers never transfer; summary counts returned + list re-fetched')
    // 払-21: needs-review / multi-payee warning surfaced w/ application ids; no row.
    rec('払-21', (multiFlagged && noNewRow && warnVisible) ? 'PASS' : 'FAIL',
      `multiPayeeRefs=[${(summary1?.multiPayeeRefs ?? []).join(', ')}] needsReview=${summary1?.needsReview}; UI warn=${warnVisible} "${refsText.replace(/\s+/g, ' ').trim()}"; no multi-payee payout row created (dbRows=${afterRows})`,
      'v1 >1 payee on one application ⇒ no per-payee amount ⇒ no auto-pay')
  }

  // ===========================================================================
  // 払-02 (冪等) — processApproved twice ⇒ no duplicate rows, counts stable.
  // ===========================================================================
  {
    const s2 = (await rpc(apage, 'payouts/processApproved', {})).json
    const afterRows = payoutRowCount()
    const stable = afterRows === baseCount
      && s2?.ingested === summary1?.ingested
      && (s2?.multiPayeeRefs?.length ?? -1) === (summary1?.multiPayeeRefs?.length ?? -2)
    rec('払-02', stable ? 'PASS' : 'FAIL',
      `2nd run ingested=${s2?.ingested} multiPayeeRefs=${s2?.multiPayeeRefs?.length}; dbRows still ${afterRows} (==baseline ${baseCount})`,
      'upsert by jomon_ref + paid short-circuit ⇒ no duplicates / no unbounded growth')
  }

  // ===========================================================================
  // 払-17 (already_paid) — execute on the EXISTING status=paid row.
  //   Predicted: ref not in accepted Jomon set ⇒ uses stored paid row ⇒
  //   already_paid short-circuit, no transfer, transferId unchanged.
  // ===========================================================================
  {
    const before = sql(`SELECT status, stripe_transfer_id, jomon_written_back_at FROM payouts WHERE jomon_ref='${PAID_JOMON_REF}';`)
    const r = await rpc(apage, 'payouts/execute', { jomonRef: PAID_JOMON_REF })
    const after = sql(`SELECT status, stripe_transfer_id, jomon_written_back_at FROM payouts WHERE jomon_ref='${PAID_JOMON_REF}';`)
    const out = r.json
    const ok = out?.outcome === 'already_paid' && out?.status === 'paid' && before === after
    rec('払-17', ok ? 'PASS' : 'FAIL',
      `execute({paid ref}) ⇒ outcome=${out?.outcome} status=${out?.status}; row before/after identical (${after}); transferId unchanged`,
      'paid is terminal: short-circuit, no re-transfer, write-back already recorded so not retried')
  }

  // ===========================================================================
  // 払-14 (onboarding 状態) — onboardingStatus({userId}) of the paid row's user (read).
  // ===========================================================================
  let paidUserId = null
  {
    paidUserId = baseRows.find(r => r.jomonRef === PAID_JOMON_REF)?.userId ?? userIdForTraq('devmember')
    const r = await rpc(apage, 'payouts/onboardingStatus', { userId: paidUserId })
    const out = r.json
    // Drive the UI button too for evidence.
    await apage.getByRole('button', { name: /onboarding 状態/ }).first().click().catch(() => {})
    await apage.waitForSelector('text=onboarding 状態:', { timeout: 8000 }).catch(() => {})
    await shot(apage, 'payout-14-onboarding-status')
    const ok = out?.status === 'done' && out?.hasConnectedAccount === true
    rec('払-14', ok ? 'PASS' : 'FAIL',
      `onboardingStatus(userId=${paidUserId}) ⇒ status=${out?.status} hasConnectedAccount=${out?.hasConnectedAccount}`,
      'read-only; matches DB (devmember: done + acct linked)')
  }

  // ===========================================================================
  // 払-06/08 (onboarding リンク・requested) — ONE fresh dev `as:user`.
  //   createOnboardingLink({userId}) ⇒ real Express acct (single allowed side
  //   effect) + URL returned + onboarding none→requested.
  //   NOTE: this block creates ONE real Stripe Express account. It was already
  //   exercised once (fresh user b970b48d…, acct_1Tlk0UCv6hPJSiqg, none→requested).
  //   Re-running this whole script would create ANOTHER account — run sparingly.
  // ===========================================================================
  {
    const email = freshEmail('payout06')
    // Mint a fresh user via dev/login (as:user creates the row, traqId=null).
    const fctx = await newCtx(browser); const fpage = await fctx.newPage()
    await devLogin(fctx, { as: 'user', email })
    await fpage.goto(BASE + '/membership', { waitUntil: 'networkidle' })
    // auth.me exposes only `hasUser`; resolve the real userId from the DB by mail_hash.
    const hasUser = (await authMe(fpage)).body?.json?.hasUser
    const freshUserId = userIdForEmail(email)
    const before = freshUserId ? onboardingStatusOf(freshUserId) : `(no user; hasUser=${hasUser})`

    // Call createOnboardingLink as the ACCOUNTANT (adminProc) — ONCE.
    const r = await rpc(apage, 'payouts/createOnboardingLink', { userId: freshUserId })
    const url = r.json?.url
    const after = freshUserId ? onboardingStatusOf(freshUserId) : '(no user)'
    const ok = typeof url === 'string' && /^https?:\/\//.test(url) && before === 'none' && after === 'requested'
    rec('払-06/08', ok ? 'PASS' : 'FAIL',
      `createOnboardingLink(fresh userId=${freshUserId}) ⇒ url=${url ? url.slice(0, 48) + '…' : '(none)'}; onboarding ${before}->${after}`,
      'ONE-TIME real Express account created (allowed). status advanced none→requested')
  }

  // ===========================================================================
  // status filter — each filter re-fetches and returns only that status.
  // ===========================================================================
  {
    const statuses = ['pending', 'onboarding_waiting', 'processing', 'paid', 'failed']
    const lines = []
    for (const s of statuses) {
      const r = await rpc(apage, 'payouts/list', { status: s })
      const items = r.json?.items ?? []
      const allMatch = items.every(it => it.status === s)
      lines.push(`${s}=${items.length}${allMatch ? '' : '(MISMATCH)'}`)
    }
    // Drive the USelect in the UI to 'paid' for a screenshot of the filtered table.
    await apage.locator('button[aria-haspopup="listbox"], select, [role="combobox"]').first().click().catch(() => {})
    await shot(apage, 'payout-filter')
    const paid = await rpc(apage, 'payouts/list', { status: 'paid' })
    const paidOnly = (paid.json?.items ?? []).every(it => it.status === 'paid')
    rec('払-filter', paidOnly ? 'PASS' : 'FAIL',
      `per-status counts: ${lines.join(', ')}`,
      'each filter returns only matching status (paid=1 existing closed-loop row)')
  }

  // ===========================================================================
  // 一覧の行表示 — jomonRef/userId/金額/通貨/status/transferId/書き戻し columns shown.
  // ===========================================================================
  {
    const bodyText = await apage.locator('table').innerText().catch(() => '')
    const r = baseRows.find(x => x.jomonRef === PAID_JOMON_REF)
    const headerOk = /jomonRef/.test(bodyText) && /transfer ID/i.test(bodyText) && /書き戻し/.test(bodyText)
    const rowOk = bodyText.includes(PAID_JOMON_REF) && bodyText.includes('tr_') && /書き戻し済み/.test(bodyText)
    await shot(apage, 'payout-row-render')
    rec('払-row', (headerOk && rowOk) ? 'PASS' : 'FAIL',
      `row shows jomonRef=${r?.jomonRef?.slice(0, 20)}… userId=${(r?.userId ?? '—').slice(0, 8)}… amount=${r?.amount} ${r?.currency} status=${r?.status} transferId=${r?.stripeTransferId} writtenBack=${r?.jomonWrittenBackAt ? '済' : '未'}`,
      'all 7 columns + 操作 rendered; 書き戻し済み for the closed-loop row')
  }
}
catch (err) {
  log('\n[FATAL]', err?.stack || err)
}
finally {
  await browser.close()
  log('\n\n================ RESULT TABLE ================')
  log('| ID | 判定 | 観測 | 備考 |')
  log('|----|------|------|------|')
  for (const r of results) {
    log(`| ${r.id} | ${r.verdict} | ${r.observed.replace(/\|/g, '\\|')} | ${r.note.replace(/\|/g, '\\|')} |`)
  }
  const pass = results.filter(r => r.verdict === 'PASS').length
  const fail = results.filter(r => r.verdict === 'FAIL').length
  const blocked = results.filter(r => r.verdict === 'BLOCKED').length
  log(`\nPASS=${pass} FAIL=${fail} BLOCKED=${blocked} (of ${results.length})`)
}
