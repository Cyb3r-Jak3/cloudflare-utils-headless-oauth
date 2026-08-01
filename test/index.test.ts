import { describe, it, expect, beforeEach, vi } from 'vitest'
import { env } from 'cloudflare:test'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import app from '../src/index'
import { registrationsTable } from '../src/schema'

const CLIENT_ID = 'bec7176151194b99ec5c0b907e74f567'

function makeOAuthProvider(overrides: Partial<{
  parseAuthRequest: ReturnType<typeof vi.fn>
  lookupClient: ReturnType<typeof vi.fn>
}> = {}) {
  return {
    parseAuthRequest: overrides.parseAuthRequest ?? vi.fn(),
    lookupClient: overrides.lookupClient ?? vi.fn(),
  }
}

function testEnv(oauthOverrides = {}) {
  return {
    ...env,
    OAUTH_PROVIDER: makeOAuthProvider(oauthOverrides),
  }
}

function mockExecutionContext(): ExecutionContext {
  return {
    waitUntil: (promise: Promise<unknown>) => {
      promise.catch(() => {})
    },
    passThroughOnException: () => {},
    props: {},
  } as ExecutionContext
}

const db = () => drizzle(env.D1)

async function insertRegistration(values: {
  registrationId: string
  codeVerifier?: string | null
  accessToken?: string | null
  expiresAt: number
}) {
  await db().insert(registrationsTable).values(values)
}

async function getRegistration(registrationId: string) {
  const [row] = await db()
    .select()
    .from(registrationsTable)
    .where(eq(registrationsTable.registrationId, registrationId))
    .limit(1)
  return row
}

beforeEach(async () => {
  await env.D1.exec('DELETE FROM registrations')
  vi.restoreAllMocks()
})

describe('POST /oauth/register', () => {
  it('creates a pending registration and returns a poll url', async () => {
    const res = await app.request('/oauth/register', { method: 'POST' }, testEnv())
    expect(res.status).toBe(200)

    const body = await res.json() as { registration_id: string; url: string; expires_in: number }
    expect(body.registration_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.expires_in).toBe(600)
    expect(body.url).toContain(`/register/${body.registration_id}`)

    const row = await getRegistration(body.registration_id)
    expect(row).toBeTruthy()
    expect(row.codeVerifier).toBeTruthy()
    expect(row.accessToken).toBeNull()
  })
})

describe('GET /oauth/register/:registrationId', () => {
  it('redirects to the Cloudflare authorize URL with PKCE params', async () => {
    await insertRegistration({
      registrationId: 'reg-1',
      codeVerifier: 'test-verifier',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })

    const res = await app.request('/oauth/register/reg-1', { redirect: 'manual' }, testEnv())
    expect(res.status).toBe(302)

    const location = new URL(res.headers.get('location')!)
    expect(location.origin + location.pathname).toBe('https://dash.cloudflare.com/oauth2/auth')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location.searchParams.get('state')).toBe('reg-1')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
    expect(location.searchParams.get('code_challenge')).toBeTruthy()
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost/oauth/callback')
  })

  it('returns 404 for an unknown registration', async () => {
    const res = await app.request('/oauth/register/does-not-exist', {}, testEnv())
    expect(res.status).toBe(404)
  })

  it('returns 404 when the registration was already completed', async () => {
    await insertRegistration({
      registrationId: 'reg-used',
      codeVerifier: null,
      accessToken: 'already-issued',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })

    const res = await app.request('/oauth/register/reg-used', {}, testEnv())
    expect(res.status).toBe(404)
  })

  it('returns 410 and deletes the row when the registration expired', async () => {
    await insertRegistration({
      registrationId: 'reg-expired',
      codeVerifier: 'test-verifier',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    })

    const res = await app.request('/oauth/register/reg-expired', {}, testEnv())
    expect(res.status).toBe(410)
    expect(await getRegistration('reg-expired')).toBeUndefined()
  })
})

describe('GET /oauth/callback', () => {
  it('exchanges the code with Cloudflare and stores the access token', async () => {
    await insertRegistration({
      registrationId: 'reg-cb',
      codeVerifier: 'test-verifier',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      expect(url).toBe('https://dash.cloudflare.com/oauth2/token')
      const body = new URLSearchParams(init?.body as string)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('client_id')).toBe(CLIENT_ID)
      expect(body.get('code')).toBe('cf-auth-code')
      expect(body.get('code_verifier')).toBe('test-verifier')
      return new Response(JSON.stringify({
        access_token: 'mock-cf-access-token',
        refresh_token: 'mock-cf-refresh-token',
        expires_in: 3600,
        scope: 'page.write dns.write',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const res = await app.request(
      '/oauth/callback?code=cf-auth-code&state=reg-cb',
      {},
      testEnv(),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Login complete')

    const row = await getRegistration('reg-cb')
    expect(row.accessToken).toBe('mock-cf-access-token')
    expect(row.codeVerifier).toBeNull()
  })

  it('returns 400 when Cloudflare reports an error', async () => {
    const res = await app.request('/oauth/callback?error=access_denied&state=reg-cb', {}, testEnv())
    expect(res.status).toBe(400)
  })

  it('returns 400 when code or state is missing', async () => {
    const res = await app.request('/oauth/callback?code=abc', {}, testEnv())
    expect(res.status).toBe(400)
  })

  it('returns 404 for an unknown registration', async () => {
    const res = await app.request('/oauth/callback?code=abc&state=missing', {}, testEnv())
    expect(res.status).toBe(404)
  })

  it('returns 410 when the registration expired', async () => {
    await insertRegistration({
      registrationId: 'reg-cb-expired',
      codeVerifier: 'test-verifier',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    })

    const res = await app.request(
      '/oauth/callback?code=abc&state=reg-cb-expired',
      {},
      testEnv(),
    )
    expect(res.status).toBe(410)
  })

  it('returns 502 when the Cloudflare token exchange fails', async () => {
    await insertRegistration({
      registrationId: 'reg-cb-fail',
      codeVerifier: 'test-verifier',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 400 }))

    const res = await app.request(
      '/oauth/callback?code=abc&state=reg-cb-fail',
      {},
      testEnv(),
    )
    expect(res.status).toBe(502)
  })
})

describe('GET /oauth/token/:registrationId', () => {
  it('returns pending while no access token is present', async () => {
    await insertRegistration({
      registrationId: 'reg-tok-pending',
      codeVerifier: 'test-verifier',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })

    const res = await app.request('/oauth/token/reg-tok-pending', {}, testEnv())
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'pending' })
  })

  it('returns the token once and then reports not_found (one-time reveal)', async () => {
    await insertRegistration({
      registrationId: 'reg-tok-done',
      codeVerifier: null,
      accessToken: 'issued-token',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })

    const first = await app.request('/oauth/token/reg-tok-done', {}, testEnv())
    expect(first.status).toBe(200)
    expect(first.headers.get('content-type')).toBe('application/json+oauthv1')
    const body = await first.json() as { status: string; access_token: string }
    expect(body.status).toBe('complete')
    expect(body.access_token).toBe('issued-token')

    const second = await app.request('/oauth/token/reg-tok-done', {}, testEnv())
    expect(second.status).toBe(404)
    expect(await second.json()).toEqual({ status: 'not_found' })
  })

  it('returns not_found for an unknown registration', async () => {
    const res = await app.request('/oauth/token/does-not-exist', {}, testEnv())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ status: 'not_found' })
  })

  it('returns not_found and deletes an expired pending registration', async () => {
    await insertRegistration({
      registrationId: 'reg-tok-expired',
      codeVerifier: 'test-verifier',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    })

    const res = await app.request('/oauth/token/reg-tok-expired', {}, testEnv(), mockExecutionContext())
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ status: 'not_found' })
  })
})

describe('GET /oauth/authorize', () => {
  it('returns 400 when the auth request cannot be parsed', async () => {
    const parseAuthRequest = vi.fn().mockRejectedValue(new Error('bad request'))
    const res = await app.request('/oauth/authorize', {}, testEnv({ parseAuthRequest }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when the client id does not match', async () => {
    const parseAuthRequest = vi.fn().mockResolvedValue({
      clientId: 'someone-else',
      redirectUri: 'https://example.com/cb',
      responseType: 'code',
      scope: ['page.write'],
      state: 'xyz',
    })
    const lookupClient = vi.fn().mockResolvedValue({ clientId: 'someone-else', redirectUris: ['https://example.com/cb'] })

    const res = await app.request('/oauth/authorize', {}, testEnv({ parseAuthRequest, lookupClient }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when the redirect URI is not registered for the client', async () => {
    const parseAuthRequest = vi.fn().mockResolvedValue({
      clientId: CLIENT_ID,
      redirectUri: 'https://evil.example.com/cb',
      responseType: 'code',
      scope: ['page.write'],
      state: 'xyz',
    })
    const lookupClient = vi.fn().mockResolvedValue({ clientId: CLIENT_ID, redirectUris: ['https://example.com/cb'] })

    const res = await app.request('/oauth/authorize', {}, testEnv({ parseAuthRequest, lookupClient }))
    expect(res.status).toBe(400)
  })

  it('redirects to the login page with the request parameters', async () => {
    const parseAuthRequest = vi.fn().mockResolvedValue({
      clientId: CLIENT_ID,
      redirectUri: 'https://example.com/cb',
      responseType: 'code',
      scope: ['page.write', 'dns.write'],
      state: 'xyz',
      codeChallenge: 'challenge-value',
      codeChallengeMethod: 'S256',
    })
    const lookupClient = vi.fn().mockResolvedValue({ clientId: CLIENT_ID, redirectUris: ['https://example.com/cb'] })

    const res = await app.request(
      '/oauth/authorize',
      { redirect: 'manual' },
      testEnv({ parseAuthRequest, lookupClient }),
    )
    expect(res.status).toBe(302)

    const location = new URL(res.headers.get('location')!, 'http://localhost')
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(location.searchParams.get('redirect_uri')).toBe('https://example.com/cb')
    expect(location.searchParams.get('scope')).toBe('page.write dns.write')
    expect(location.searchParams.get('state')).toBe('xyz')
    expect(location.searchParams.get('code_challenge')).toBe('challenge-value')
    expect(location.searchParams.get('code_challenge_method')).toBe('S256')
  })
})
