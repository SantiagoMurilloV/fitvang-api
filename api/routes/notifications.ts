import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { notifications, pushSubscriptions } from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { env } from '../lib/env';

export const notificationsRouter = new Hono();
notificationsRouter.use('*', requireAuth);

notificationsRouter.get('/vapid-public', (c) => c.json({ key: env.VAPID_PUBLIC_KEY }));

notificationsRouter.get('/', async (c) => {
  const me = c.get('user');
  const limit = Number(c.req.query('limit') ?? '50');
  const rows = await db
    .select()
    .from(notifications)
    .where(eq(notifications.userId, me.sub))
    .orderBy(desc(notifications.createdAt))
    .limit(limit);
  const unreadRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.userId, me.sub), eq(notifications.leida, false)));
  return c.json({ notifications: rows, unread: unreadRows[0]?.count ?? 0 });
});

notificationsRouter.post('/read-all', async (c) => {
  const me = c.get('user');
  await db.update(notifications).set({ leida: true }).where(eq(notifications.userId, me.sub));
  return c.json({ ok: true });
});

notificationsRouter.post('/:id/read', async (c) => {
  const me = c.get('user');
  await db
    .update(notifications)
    .set({ leida: true })
    .where(and(eq(notifications.id, c.req.param('id')), eq(notifications.userId, me.sub)));
  return c.json({ ok: true });
});

// Subscribe push
const subSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
  userAgent: z.string().optional(),
});

notificationsRouter.post('/subscribe', zValidator('json', subSchema), async (c) => {
  const me = c.get('user');
  const body = c.req.valid('json');
  await db
    .insert(pushSubscriptions)
    .values({
      userId: me.sub,
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      userAgent: body.userAgent,
      activa: true,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: me.sub, p256dh: body.keys.p256dh, auth: body.keys.auth, activa: true },
    });
  return c.json({ ok: true });
});

notificationsRouter.post('/unsubscribe', zValidator('json', z.object({ endpoint: z.string() })), async (c) => {
  await db
    .update(pushSubscriptions)
    .set({ activa: false })
    .where(eq(pushSubscriptions.endpoint, c.req.valid('json').endpoint));
  return c.json({ ok: true });
});
