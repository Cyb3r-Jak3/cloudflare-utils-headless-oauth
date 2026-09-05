import { Hono } from 'hono'
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import { registrationsTable } from './schema';
import {scheduled} from './scheduled'
import { EncodeBase64, NowSeconds } from '@cyb3r-jak3/workers-common'

const app = new Hono<{Bindings: CloudflareBindings}>().basePath('/oauth')
const SCOPES = 'page.write dns.write zone.read account-rule-lists.write teams-connectors.read cache.purge'

const CF_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth'
const CF_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token'
const REGISTRATION_TTL_SECONDS = 600


interface CloudflareTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
}

function generateCodeVerifier(): string {
  return EncodeBase64(crypto.getRandomValues(new Uint8Array(64)))
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return EncodeBase64(new Uint8Array(digest))
}

// This worker only ever serves a single client, so the client and its
// allowed redirect URIs are configured directly via env instead of a
// dynamic client store.
app.get('/authorize', async (c) => {
  const query = c.req.query()
  const clientId = query.client_id
  const redirectUri = query.redirect_uri
  const responseType = query.response_type
  const state = query.state
  const scope = query.scope ?? ''
  const codeChallenge = query.code_challenge
  const codeChallengeMethod = query.code_challenge_method

  if (!clientId || !redirectUri || !responseType || !state) {
    return new Response('Invalid authorization request', { status: 400 });
  }
  if (clientId !== c.env.CLIENT_ID) {
    return new Response('Invalid client', { status: 400 });
  }
  const allowedRedirectUris = c.env.REDIRECT_URIS.split(',')
  if (!allowedRedirectUris.includes(redirectUri)) {
    return new Response('Invalid redirect URI', { status: 400 });
  }
  // If the request is valid, redirect to the login page.
  const loginParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: responseType,
    scope,
    state,
  });
  if (codeChallenge) {
    loginParams.set('code_challenge', codeChallenge);
    loginParams.set('code_challenge_method', codeChallengeMethod ?? 'plain');
  }
  return c.redirect(`/login?${loginParams.toString()}`);
})

// CLI calls this from the headless machine to start a login. It gets back a
// registrationId to poll on and a URL to open on any machine with a browser.
app.post('/register', async (c) => {
  const registrationId = crypto.randomUUID()
  const codeVerifier = generateCodeVerifier()
  const expiresAt = NowSeconds() + REGISTRATION_TTL_SECONDS

  const db = drizzle(c.env.D1)
  await db.insert(registrationsTable).values({
    registrationId,
    codeVerifier,
    expiresAt,
  })

  const url = new URL(c.req.url)
  return c.json({
    registration_id: registrationId,
    url: `${url.origin}/oauth/register/${registrationId}`,
    expires_in: REGISTRATION_TTL_SECONDS,
  })
})

// The human opens this link (possibly on a different machine) to complete
// the Cloudflare login for a pending registration.
app.get('/register/:registrationId', async (c) => {
  const registrationId = c.req.param('registrationId')
  const db = drizzle(c.env.D1)
  const [row] = await db.select().from(registrationsTable).where(eq(registrationsTable.registrationId, registrationId)).limit(1)

  if (!row || !row.codeVerifier || row.accessToken) {
    return new Response('Registration not found or already used', { status: 404 })
  }
  if (row.expiresAt <= NowSeconds()) {
    await db.delete(registrationsTable).where(eq(registrationsTable.registrationId, registrationId))
    return new Response('Registration expired', { status: 410 })
  }

  const url = new URL(c.req.url)
  const codeChallenge = await generateCodeChallenge(row.codeVerifier)
  const cfAuthorizeUrl = new URL(CF_AUTHORIZE_URL)
  cfAuthorizeUrl.searchParams.set('response_type', 'code')
  cfAuthorizeUrl.searchParams.set('client_id', c.env.CLIENT_ID)
  cfAuthorizeUrl.searchParams.set('redirect_uri', `${url.origin}/oauth/callback`)
  cfAuthorizeUrl.searchParams.set('scope', `${SCOPES}`)
  cfAuthorizeUrl.searchParams.set('state', registrationId)
  cfAuthorizeUrl.searchParams.set('code_challenge', codeChallenge)
  cfAuthorizeUrl.searchParams.set('code_challenge_method', 'S256')

  return c.redirect(cfAuthorizeUrl.toString())
})

// Cloudflare redirects back here once the human approves the login.
app.get('/callback', async (c) => {
  const url = new URL(c.req.url)
  const code = url.searchParams.get('code')
  const registrationId = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return new Response(`Cloudflare login failed: ${error}`, { status: 400 })
  }
  if (!code || !registrationId) {
    return new Response('Invalid callback request', { status: 400 })
  }

  const db = drizzle(c.env.D1)
  const [row] = await db.select().from(registrationsTable).where(eq(registrationsTable.registrationId, registrationId)).limit(1)

  if (!row || !row.codeVerifier || row.accessToken) {
    return new Response('Registration not found or already used', { status: 404 })
  }
  if (row.expiresAt <= NowSeconds()) {
    await db.delete(registrationsTable).where(eq(registrationsTable.registrationId, registrationId))
    return new Response('Registration expired', { status: 410 })
  }

  const tokenResponse = await fetch(CF_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: c.env.CLIENT_ID,
      code,
      redirect_uri: `${url.origin}/oauth/callback`,
      code_verifier: row.codeVerifier,
    }),
  })

  if (!tokenResponse.ok) {
    return new Response('Failed to exchange code with Cloudflare', { status: 502 })
  }
  const tokens = await tokenResponse.json() as CloudflareTokenResponse

  await db.update(registrationsTable)
    .set({
      codeVerifier: null,
      accessToken: tokens.access_token,
      expiresAt: NowSeconds() + tokens.expires_in,
    })
    .where(eq(registrationsTable.registrationId, registrationId))

  return new Response('Login complete. You can close this window and return to the CLI.', {
    headers: { 'Content-Type': 'text/plain' },
  })
})

// CLI polls this with the registrationId from /register until the token is ready.
// One-time reveal: the first successful poll consumes the record.
app.get('/token/:registrationId', async (c) => {
  const registrationId = c.req.param('registrationId')
  const db = drizzle(c.env.D1)

  const OAUTH_V1_CONTENT_TYPE = 'application/json+oauthv1'

  const [row] = await db.select().from(registrationsTable).where(eq(registrationsTable.registrationId, registrationId)).limit(1)
  if (!row) {
    return c.json({ status: 'not_found' }, 404)
  }

  if (row.accessToken) {
    await db.delete(registrationsTable).where(eq(registrationsTable.registrationId, registrationId))
    return c.json({
      status: 'complete',
      access_token: row.accessToken,
      expires_at: row.expiresAt,
    }, 200, { 'Content-Type': OAUTH_V1_CONTENT_TYPE })
  }

  if (row.expiresAt <= NowSeconds()) {
    c.executionCtx.waitUntil(db.delete(registrationsTable).where(eq(registrationsTable.registrationId, registrationId)))
    return c.json({ status: 'not_found' }, 404, { 'Content-Type': OAUTH_V1_CONTENT_TYPE })
  }

  return c.json({ status: 'pending' }, 202)
})

export default {
  fetch: app.fetch,
  scheduled: scheduled
}
