import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, or, desc, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { notifications, pushSubscriptions, users, notificationTemplates } from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { requireAdmin } from '../middleware/rbac';
import { notifyUser } from '../services/webpush.service';
import { env } from '../lib/env';

export const notificationsRouter = new Hono();
notificationsRouter.use('*', requireAuth);

notificationsRouter.get('/vapid-public', (c) => c.json({ key: env.VAPID_PUBLIC_KEY }));

notificationsRouter.get('/', async (c) => {
  const me = c.get('user');
  const limit = Number(c.req.query('limit') ?? '50');
  const rows = await db
    .select({
      id: notifications.id,
      tipo: notifications.tipo,
      titulo: notifications.titulo,
      mensaje: notifications.mensaje,
      leida: notifications.leida,
      deepLinkUrl: notifications.deepLinkUrl,
      createdAt: notifications.createdAt,
    })
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

// ── Envío masivo / dirigido (solo super_admin) ──────────────────────────────
// target 'all'      → todos los usuarios activos con rol 'user'
// target 'specific' → los userIds dados, filtrados a usuarios activos reales
const broadcastSchema = z.object({
  titulo: z.string().trim().min(1).max(120),
  mensaje: z.string().trim().min(1).max(500),
  deepLinkUrl: z.string().trim().max(300).optional(),
  target: z.enum(['all', 'specific']),
  // Audiencias por tipo (solo aplica a target 'all'). Vacío/ausente = todas.
  audiences: z.array(z.enum(['miembros', 'acudientes', 'coaches'])).optional(),
  userIds: z.array(z.string().uuid()).max(5000).optional(),
});

// Construye la condición SQL para un conjunto de audiencias.
function audienceCondition(audiences?: string[]) {
  const auds = audiences && audiences.length ? audiences : ['miembros', 'acudientes', 'coaches'];
  const parts = [];
  if (auds.includes('miembros')) parts.push(and(eq(users.rol, 'user'), eq(users.esAcudiente, false)));
  if (auds.includes('acudientes')) parts.push(and(eq(users.rol, 'user'), eq(users.esAcudiente, true)));
  if (auds.includes('coaches')) parts.push(eq(users.rol, 'coach'));
  return parts.length ? or(...parts) : undefined;
}

notificationsRouter.post('/broadcast', requireAdmin, zValidator('json', broadcastSchema), async (c) => {
  const body = c.req.valid('json');

  if (body.target === 'specific' && (!body.userIds || body.userIds.length === 0)) {
    return c.json({ error: 'sin_destinatarios' }, 400);
  }

  // Resolver destinatarios reales en la BD (evita enviar a IDs borrados/inactivos).
  // - specific: cualquier usuario activo de cualquier tipo entre los IDs dados.
  // - all: usuarios activos que pertenezcan a las audiencias elegidas.
  const where =
    body.target === 'specific'
      ? and(eq(users.activo, true), inArray(users.id, body.userIds!))
      : and(eq(users.activo, true), audienceCondition(body.audiences));

  const rows = await db.select({ id: users.id }).from(users).where(where);
  const targetIds = rows.map((r) => r.id);
  if (targetIds.length === 0) return c.json({ ok: true, sent: 0 });

  const url = body.deepLinkUrl && body.deepLinkUrl.length > 0 ? body.deepLinkUrl : '/app';

  // notifyUser = inbox (campanita) + web-push best-effort; nunca lanza. En lotes
  // para no abrir cientos de conexiones push a la vez.
  const BATCH = 25;
  for (let i = 0; i < targetIds.length; i += BATCH) {
    const slice = targetIds.slice(i, i + BATCH);
    await Promise.allSettled(
      slice.map((uid) =>
        notifyUser(uid, { title: body.titulo, body: body.mensaje, url }, { tipo: 'sistema' }),
      ),
    );
  }

  // Guardar en el historial reutilizable (upsert por titulo+mensaje).
  await db
    .insert(notificationTemplates)
    .values({ titulo: body.titulo, mensaje: body.mensaje })
    .onConflictDoUpdate({
      target: [notificationTemplates.titulo, notificationTemplates.mensaje],
      set: { updatedAt: new Date() },
    })
    .catch(() => {});

  return c.json({ ok: true, sent: targetIds.length });
});

// ── Historial de mensajes reutilizables (solo super_admin) ──────────────────
notificationsRouter.get('/templates', requireAdmin, async (c) => {
  const rows = await db
    .select({
      id: notificationTemplates.id,
      titulo: notificationTemplates.titulo,
      mensaje: notificationTemplates.mensaje,
      updatedAt: notificationTemplates.updatedAt,
    })
    .from(notificationTemplates)
    .orderBy(desc(notificationTemplates.updatedAt))
    .limit(50);
  return c.json({ templates: rows });
});

notificationsRouter.delete('/templates/:id', requireAdmin, async (c) => {
  await db.delete(notificationTemplates).where(eq(notificationTemplates.id, c.req.param('id')));
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
  const me = c.get('user');
  // Solo el dueño puede desactivar su propia suscripción
  await db
    .update(pushSubscriptions)
    .set({ activa: false })
    .where(and(eq(pushSubscriptions.endpoint, c.req.valid('json').endpoint), eq(pushSubscriptions.userId, me.sub)));
  return c.json({ ok: true });
});
