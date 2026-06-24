// Shared Playwright harness for Checkin UI verification (read-only checks).
// Usage: import { launch, BASE, newCtx, devLogin, freshEmail, shot } from './harness.mjs'
//
// NOTE: Chromium over http://localhost does NOT persist the app's `Secure`
// `__Host-` cookies from Set-Cookie, so we mint the dev session via curl and
// INJECT the session + CSRF cookies with ctx.addCookies(). CSRF is a stateless
// double-submit (server compares cookie === `x-csrf-token`), so any fixed CSRF
// value works as long as cookie and header match — the in-page oRPC plugin
// reads the (non-httpOnly) CSRF cookie and mirrors it into the header.
import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

export const BASE = process.env.E2E_BASE || 'http://localhost:13000'
const EXE = '/home/kaitoyama/.cache/ms-playwright/chromium-1169/chrome-linux/chrome'
export const SHOTS = '/home/kaitoyama/Checkin/scripts/e2e/shots'
const SESSION_COOKIE = '__Host-checkin_session'
const CSRF_COOKIE = '__Host-checkin_csrf'
const CSRF_VALUE = 'e2e-csrf-token-fixed'
mkdirSync(SHOTS, { recursive: true })

export async function launch() {
  return chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox'] })
}

// Fresh browser context (no cookie bleed between scenarios).
export async function newCtx(browser) {
  return browser.newContext({ baseURL: BASE })
}

// Mint a dev session token via curl (server sets it on a 302 we read from -i).
function mintToken(as, email) {
  const u = new URL(BASE + '/dev/login')
  u.searchParams.set('as', as)
  if (email) u.searchParams.set('email', email)
  u.searchParams.set('redirect', '/')
  const hdrs = execFileSync('curl', ['-s', '-i', u.toString()], { encoding: 'utf8' })
  const m = hdrs.match(/set-cookie:\s*__Host-checkin_session=([^;]+)/i)
  if (!m) throw new Error('dev/login did not return a session cookie (as=' + as + ')')
  return m[1]
}

// Establish an authenticated session in `ctx` for the given identity by injecting
// the session + CSRF cookies. Pass the SAME `ctx` whose pages you will drive.
// as: 'admin' | 'member' | 'user' | 'both'. email used for user/both (fresh per test).
// Returns { token }. For anon, skip calling this.
export async function devLogin(ctx, { as = 'admin', email } = {}) {
  const token = mintToken(as, email)
  await ctx.addCookies([
    { name: SESSION_COOKIE, value: token, domain: 'localhost', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: CSRF_COOKIE, value: CSRF_VALUE, domain: 'localhost', path: '/', httpOnly: false, secure: true, sameSite: 'Lax' },
  ])
  return { token }
}

// Unique isct email per scenario to avoid ledger/customer collisions.
export function freshEmail(tag) {
  const n = `${tag}-${process.pid}-${Math.floor(performance.now())}`
  return `e2e-${n}@m.isct.ac.jp`
}

export async function shot(page, name) {
  const path = `${SHOTS}/${name}.png`
  await page.screenshot({ path, fullPage: true }).catch(() => {})
  return path
}

// Convenience: read auth.me via the in-page orpc client is overkill; just hit the
// public endpoint through fetch within the page context (carries cookies).
export async function authMe(page) {
  return page.evaluate(async (base) => {
    const r = await fetch(base + '/rpc/auth/me', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, BASE)
}
