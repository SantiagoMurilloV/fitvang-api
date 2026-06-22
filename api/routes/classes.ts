import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  classTemplates,
  classSessions,
  trainingTypes,
  coaches,
  bookings,
  users,
} from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { requireAdmin, requireStaff } from '../middleware/rbac';
import { generateUpcomingSessions } from '../services/scheduler.service';
import { notifyUser } from '../services/webpush.service';

export const classesRouter = new Hono();
classesRouter.use('*', requireAuth);

// ---- Templates ----
const templateSchema = z.object({
  nombre: z.string().trim().min(2).max(100),
  trainingTypeId: z.string().uuid(),
  coachId: z.string().uuid().optional(),
  diaSemana: z.enum(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']),
  horaInicio: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  horaFin: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  capacidadMax: z.number().int().positive().max(500).default(20),
  activo: z.boolean().default(true),
});

classesRouter.get('/templates', async (c) => {
  const rows = await db
    .select({
      id: classTemplates.id,
      nombre: classTemplates.nombre,
      trainingTypeId: classTemplates.trainingTypeId,
      trainingSlug: trainingTypes.slug,
      trainingNombre: trainingTypes.nombre,
      trainingColor: trainingTypes.colorHex,
      coachId: classTemplates.coachId,
      diaSemana: classTemplates.diaSemana,
      horaInicio: classTemplates.horaInicio,
      horaFin: classTemplates.horaFin,
      capacidadMax: classTemplates.capacidadMax,
      activo: classTemplates.activo,
    })
    .from(classTemplates)
    .innerJoin(trainingTypes, eq(classTemplates.trainingTypeId, trainingTypes.id))
    .orderBy(classTemplates.diaSemana, classTemplates.horaInicio);
  return c.json({ templates: rows });
});

classesRouter.post('/templates', requireAdmin, zValidator('json', templateSchema), async (c) => {
  const [row] = await db.insert(classTemplates).values(c.req.valid('json')).returning({ id: classTemplates.id });
  return c.json({ id: row.id });
});

classesRouter.patch('/templates/:id', requireAdmin, zValidator('json', templateSchema.partial()), async (c) => {
  await db.update(classTemplates).set(c.req.valid('json')).where(eq(classTemplates.id, c.req.param('id')));
  return c.json({ ok: true });
});

// ---- Sessions ----
classesRouter.get('/sessions', async (c) => {
  const from = c.req.query('from') ?? new Date().toISOString().slice(0, 10);
  const to = c.req.query('to') ?? from;
  const trainingSlug = c.req.query('training');

  const rows = await db
    .select({
      id: classSessions.id,
      templateId: classSessions.templateId,
      fecha: classSessions.fecha,
      estado: classSessions.estado,
      nombre: classTemplates.nombre,
      trainingTypeId: classTemplates.trainingTypeId,
      trainingSlug: trainingTypes.slug,
      trainingNombre: trainingTypes.nombre,
      trainingColor: trainingTypes.colorHex,
      coachId: classTemplates.coachId,
      horaInicio: classTemplates.horaInicio,
      horaFin: classTemplates.horaFin,
      diaSemana: classTemplates.diaSemana,
      capacidadMax: classTemplates.capacidadMax,
      ocupados: sql<number>`COALESCE((SELECT COUNT(*)::int FROM ${bookings} b WHERE b.session_id = ${classSessions.id} AND b.estado IN ('activa','asistio'))::int, 0)`,
    })
    .from(classSessions)
    .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .innerJoin(trainingTypes, eq(classTemplates.trainingTypeId, trainingTypes.id))
    .where(and(gte(classSessions.fecha, from), lte(classSessions.fecha, to)))
    .orderBy(classSessions.fecha, classTemplates.horaInicio);

  const filtered = trainingSlug ? rows.filter((r) => r.trainingSlug === trainingSlug) : rows;
  return c.json({ sessions: filtered });
});

classesRouter.post('/sessions/:id/cancel', requireStaff, async (c) => {
  const me = c.get('user');
  const { motivo } = await c.req.json().catch(() => ({ motivo: undefined }));
  const sessionId = c.req.param('id');

  await db
    .update(classSessions)
    .set({ estado: 'cancelada', cancelacionMotivo: motivo, canceladaPor: me.sub })
    .where(eq(classSessions.id, sessionId));

  // Notificar a todos los usuarios con reserva activa
  const activeBookings = await db
    .select({ userId: bookings.userId })
    .from(bookings)
    .where(and(eq(bookings.sessionId, sessionId), eq(bookings.estado, 'activa')));

  await Promise.all(
    activeBookings.map((b) =>
      notifyUser(b.userId, {
        title: 'Clase cancelada',
        body: motivo ? `La clase fue cancelada: ${motivo}` : 'Una de tus clases reservadas fue cancelada.',
        url: '/app/horarios',
      }, { tipo: 'clase_cancelada' }).catch(() => {})
    )
  );

  return c.json({ ok: true, notificados: activeBookings.length });
});

// Generar sesiones manualmente
classesRouter.post('/generate', requireAdmin, async (c) => {
  const days = Number(c.req.query('days') ?? '30');
  const n = await generateUpcomingSessions(days);
  return c.json({ inserted: n });
});

// Lista de asistentes de una sesión (coach view)
classesRouter.get('/sessions/:id/attendees', requireStaff, async (c) => {
  const sessionId = c.req.param('id');
  const rows = await db
    .select({
      bookingId: bookings.id,
      userId: bookings.userId,
      estado: bookings.estado,
      nombre: users.nombreCompleto,
      avatarUrl: users.avatarUrl,
      esMenor: users.esMenor,
    })
    .from(bookings)
    .innerJoin(users, eq(bookings.userId, users.id))
    .where(and(eq(bookings.sessionId, sessionId), inArray(bookings.estado, ['activa', 'asistio', 'no_asistio'])));
  return c.json({ attendees: rows });
});

// Training types (catálogo)
classesRouter.get('/training-types', async (c) => {
  const rows = await db.select().from(trainingTypes).where(eq(trainingTypes.activo, true)).orderBy(trainingTypes.ordenVisual);
  return c.json({ trainingTypes: rows });
});

// Lista de coaches
classesRouter.get('/coaches', requireAdmin, async (c) => {
  const rows = await db
    .select({
      id: coaches.id,
      especialidad: coaches.especialidad,
      activo: coaches.activo,
      nombre: users.nombreCompleto,
      email: users.email,
    })
    .from(coaches)
    .innerJoin(users, eq(coaches.id, users.id));
  return c.json({ coaches: rows });
});
