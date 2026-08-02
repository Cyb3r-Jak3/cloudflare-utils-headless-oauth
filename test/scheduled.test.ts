import { describe, it, expect, beforeEach, vi } from 'vitest'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { scheduled } from '../src/scheduled'
import { registrationsTable } from '../src/schema'
import { env } from "cloudflare:workers"
import {
	createExecutionContext,
	createScheduledController,
	waitOnExecutionContext,
} from "cloudflare:test";

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

describe('scheduled', () => {
  it('deletes expired registrations and logs how many were removed', async () => {
    await insertRegistration({
      registrationId: 'expired-1',
      codeVerifier: 'v1',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    })
    await insertRegistration({
      registrationId: 'expired-2',
      codeVerifier: 'v2',
      expiresAt: Math.floor(Date.now() / 1000) - 1,
    })
    await insertRegistration({
      registrationId: 'active-1',
      codeVerifier: 'v3',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const ctx = createExecutionContext();
    await scheduled(createScheduledController(), env, ctx )
    await waitOnExecutionContext(ctx);

    expect(await getRegistration('expired-1')).toBeUndefined()
    expect(await getRegistration('expired-2')).toBeUndefined()
    expect(await getRegistration('active-1')).toBeTruthy()
    expect(logSpy).toHaveBeenCalledWith('Deleted 2 expired registrations.')
  })

  it('logs single expired registration', async () => {
    await insertRegistration({
      registrationId: 'expired-1',
      codeVerifier: 'v1',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const ctx = createExecutionContext();
    await scheduled(createScheduledController(), env, ctx )
    await waitOnExecutionContext(ctx);

    expect(await getRegistration('expired-1')).toBeUndefined()
    expect(logSpy).toHaveBeenCalledWith('Deleted 1 expired registration.')
  })

  it('does nothing and logs zero when there are no expired registrations', async () => {
    await insertRegistration({
      registrationId: 'active-1',
      codeVerifier: 'v1',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const ctx = createExecutionContext();
    await scheduled(createScheduledController(), env, ctx )
    await waitOnExecutionContext(ctx);

    expect(await getRegistration('active-1')).toBeTruthy()
    expect(logSpy).toHaveBeenCalledWith('Deleted 0 expired registrations.')
  })
})
