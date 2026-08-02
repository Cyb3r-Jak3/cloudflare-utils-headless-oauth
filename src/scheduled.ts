import { drizzle } from 'drizzle-orm/d1';
import { lt } from 'drizzle-orm';
import { registrationsTable } from './schema';

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000)
}

export async function scheduled(controller: ScheduledController,
		env: CloudflareBindings,
		ctx: ExecutionContext,) {

	const db = drizzle(env.D1)
	const result = await db.delete(registrationsTable).where(lt(registrationsTable.expiresAt, nowSeconds()))
	console.log(`Deleted ${result.meta.changes} expired registration${result.meta.changes === 1 ? '' : 's'}.`)
}