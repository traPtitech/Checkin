import { createHash } from 'node:crypto'
import type { TraqOAuthConfig } from './config'
import { generateToken } from './crypto'

export interface PkcePair {
  verifier: string
  challenge: string
}

/** Generate a PKCE verifier and its S256 challenge (base64url of SHA-256). */
export function generatePkce(): PkcePair {
  const verifier = generateToken(32)
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** Build the traQ authorization URL for the authorization-code + PKCE flow. */
export function buildAuthorizeUrl(
  config: TraqOAuthConfig,
  params: { state: string, codeChallenge: string, redirectUri: string },
): string {
  const url = new URL(config.authorizeUrl)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', params.redirectUri)
  url.searchParams.set('scope', config.scope)
  url.searchParams.set('state', params.state)
  url.searchParams.set('code_challenge', params.codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

/** Exchange an authorization code for an access token. */
export async function exchangeCodeForToken(
  config: TraqOAuthConfig,
  params: { code: string, codeVerifier: string, redirectUri: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: config.clientId,
    code_verifier: params.codeVerifier,
  })
  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret)
  }
  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    throw new Error(`traQ token exchange failed: ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as { access_token?: string }
  if (!json.access_token) {
    throw new Error('traQ token exchange returned no access_token')
  }
  return json.access_token
}

/** Fetch the authenticated traQ user and extract its traQ ID (username). */
export async function fetchTraqUserId(config: TraqOAuthConfig, accessToken: string): Promise<string> {
  const res = await fetch(config.userinfoUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    throw new Error(`traQ userinfo failed: ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const traqId = json[config.userIdField]
  if (typeof traqId !== 'string' || !traqId) {
    throw new Error(`traQ userinfo missing field '${config.userIdField}'`)
  }
  return traqId
}
