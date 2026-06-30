import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { bookings, attendances, classSessions, classTemplates, users, guardians } from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { requireStaff } from '../middleware/rbac';
import { notifyUser } from '../services/webpush.service';
import { persistScoring } from '../services/scoring.service';

export const attendanceRouter = new Hono();
attendanceRouter.use('*', requireAuth, requireStaff);

const markSchema = z.object({
  bookingId: z.string().uuid(),
  presente: z.boolean(),
});

const bulkSchema = z.object({
  sessionId: z.string().uuid(),
  presente: z.boolean(),
});

attendanceRouter.post('/mark', zValidator('json', markSchema), async (c) => {
  const me = c.get('user');
  const { bookingId, presente } = c.req.valid('json');

  const rows = await db
    .select({
      userId: bookings.userId,
      fecha: classSessions.fecha,
      horaInicio: classTemplates.horaInicio,
    })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .where(eq(bookings.id, bookingId))
    .limit(1);

  if (!rows[0]) return c.json({ error: 'booking_not_found' }, 404);

  // Asistencia + estado del booking de forma atómica
  await db.transaction(async (tx) => {
    await tx
      .insert(attendances)
      .values({ bookingId, presente, marcadoPor: me.sub })
      .onConflictDoUpdate({
        target: attendances.bookingId,
        set: { presente, marcadoPor: me.sub, marcadoAt: new Date() },
      });
    await tx
      .update(bookings)
      .set({ estado: presente ? 'asistio' : 'no_asistio' })
      .where(eq(bookings.id, bookingId));
  });

  if (presente) {
    const hora = rows[0].horaInicio.slice(0, 5);
    const userId = rows[0].userId;
    await notifyUser(userId, {
      title: '¡Asistencia registrada! 🔥',
      body: `Tu asistencia del ${rows[0].fecha} a las ${hora} fue registrada por ${me.nombre}.`,
      url: '/app/asistencias',
    }, { tipo: 'asistencia' });
    persistScoring(userId).catch(() => {});

    // Notificar al acudiente si el usuario es menor
    const userRow = await db.select({ esMenor: users.esMenor, nombre: users.nombreCompleto })
      .from(users).where(eq(users.id, userId)).limit(1);
    if (userRow[0]?.esMenor) {
      const acudientes = await db.select({ acudienteId: guardians.acudienteId })
        .from(guardians).where(eq(guardians.menorId, userId));
      for (const a of acudientes) {
        notifyUser(a.acudienteId, {
          title: `${userRow[0].nombre} asistió 💪`,
          body: `Se registró la asistencia del ${rows[0].fecha} a las ${hora}.`,
          url: '/app',
        }, { tipo: 'asistencia' }).catch(() => {});
      }
    }
  }
  return c.json({ ok: true });
});

attendanceRouter.post('/bulk', zValidator('json', bulkSchema), async (c) => {
  const me = c.get('user');
  const { sessionId, presente } = c.req.valid('json');
  const bks = await db
    .select({ id: bookings.id, userId: bookings.userId })
    .from(bookings)
    .where(and(eq(bookings.sessionId, sessionId), inArray(bookings.estado, ['activa', 'asistio', 'no_asistio'])));

  if (bks.length === 0) return c.json({ marked: 0 });

  const ids = bks.map((b) => b.id);
  const estado = presente ? 'asistio' : 'no_asistio';

  // Batch + atómico: 2 statements (insert masivo + update por inArray) en vez de
  // 2 queries por booking. Si falla, no quedan asistencias a medias.
  await db.transaction(async (tx) => {
    await tx
      .insert(attendances)
      .values(bks.map((b) => ({ bookingId: b.id, presente, marcadoPor: me.sub })))
      .onConflictDoUpdate({
        target: attendances.bookingId,
        set: { presente, marcadoPor: me.sub, marcadoAt: new Date() },
      });
    await tx.update(bookings).set({ estado }).where(inArray(bookings.id, ids));
  });

  if (presente) {
    await Promise.allSettled(
      bks.flatMap((b) => [
        notifyUser(b.userId, {
          title: '¡Asistencia registrada!',
          body: `Tu asistencia fue marcada por ${me.nombre}.`,
          url: '/app/asistencias',
        }, { tipo: 'asistencia' }),
        persistScoring(b.userId),
      ]),
    );
  }
  return c.json({ marked: bks.length });
});
