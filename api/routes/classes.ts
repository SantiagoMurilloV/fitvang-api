import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, gte, lte, sql, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import {
  classTemplates,
  classTemplatePlans,
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
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'] as const;

const programarSchema = z.object({
  nombre: z.string().trim().min(2).max(100),
  trainingTypeId: z.string().uuid(),
  coachId: z.string().uuid().optional().nullable(),
  dias: z.array(z.enum(DIAS)).min(1),          // uno o varios días
  horaInicio: z.string().regex(/^\d{2}:\d{2}/),
  duracionMin: z.number().int().min(15).max(480).default(60),
  capacidadMax: z.number().int().positive().max(500).optional().nullable(),
  planIds: z.array(z.string().uuid()).default([]), // vacío = todos
  repetir: z.enum(['mes', 'siempre']).default('siempre'),
  generarDias: z.number().int().min(1).max(365).default(60),
});

function addMinutes(time: string, min: number): string {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + min;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

classesRouter.get('/templates', async (c) => {
  const me = c.get('user');
  const coachIdParam = c.req.query('coachId');
  // 'me' es un alias para el usuario autenticado
  const filterCoachId = coachIdParam === 'me' ? me.sub : (coachIdParam ?? null);

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
    .where(
      filterCoachId
        ? and(eq(classTemplates.activo, true), eq(classTemplates.coachId, filterCoachId))
        : eq(classTemplates.activo, true)
    )
    .orderBy(classTemplates.diaSemana, classTemplates.horaInicio);

  // Agregar planIds a cada template
  const planRows = await db.select().from(classTemplatePlans);
  const planMap: Record<string, string[]> = {};
  for (const r of planRows) {
    if (!planMap[r.templateId]) planMap[r.templateId] = [];
    planMap[r.templateId].push(r.planTypeId);
  }

  return c.json({ templates: rows.map((t) => ({ ...t, planIds: planMap[t.id] ?? [] })) });
});

// Crear clase(s) — un bloque puede crear varias plantillas (una por día)
classesRouter.post('/programar', requireAdmin, zValidator('json', programarSchema), async (c) => {
  const body = c.req.valid('json');
  const horaFin = addMinutes(body.horaInicio, body.duracionMin);
  const created: string[] = [];

  for (const dia of body.dias) {
    const [row] = await db.insert(classTemplates).values({
      nombre: body.nombre,
      trainingTypeId: body.trainingTypeId,
      coachId: body.coachId ?? undefined,
      diaSemana: dia,
      horaInicio: body.horaInicio,
      horaFin,
      capacidadMax: body.capacidadMax ?? 20,
      activo: true,
    }).returning({ id: classTemplates.id });

    if (body.planIds.length > 0) {
      await db.insert(classTemplatePlans).values(
        body.planIds.map((planTypeId) => ({ templateId: row.id, planTypeId }))
      ).onConflictDoNothing();
    }

    created.push(row.id);
  }

  // Generar sesiones
  const n = await generateUpcomingSessions(body.generarDias);
  return c.json({ ids: created, sesionesGeneradas: n });
});

// Desactivar (borrar lógico) una plantilla + eliminar sus sesiones futuras.
// Antes solo marcaba activo=false y las sesiones ya generadas quedaban huérfanas
// (seguían apareciendo en el calendario aunque la clase estuviera "borrada").
classesRouter.delete('/templates/:id', requireAdmin, async (c) => {
  const id = c.req.param('id');
  await db.transaction(async (tx) => {
    await tx.update(classTemplates).set({ activo: false }).where(eq(classTemplates.id, id));
    await tx
      .delete(classSessions)
      .where(and(eq(classSessions.templateId, id), eq(classSessions.estado, 'programada')));
  });
  return c.json({ ok: true });
});

// Whitelist explícita de columnas editables — evita mass assignment (antes se
// hacía set(rest as any) con cualquier campo del body sin validar).
const templatePatchSchema = z.object({
  nombre: z.string().trim().min(2).max(100),
  trainingTypeId: z.string().uuid(),
  coachId: z.string().uuid().nullable(),
  diaSemana: z.enum(DIAS),
  horaInicio: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  horaFin: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  capacidadMax: z.number().int().positive().max(500),
  activo: z.boolean(),
}).partial();

classesRouter.patch('/templates/:id', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const { planIds, ...rest } = body;
  if (Object.keys(rest).length) {
    const parsed = templatePatchSchema.safeParse(rest);
    if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    if (Object.keys(parsed.data).length) {
      await db.update(classTemplates).set(parsed.data).where(eq(classTemplates.id, c.req.param('id')));
    }
  }
  if (Array.isArray(planIds)) {
    await db.delete(classTemplatePlans).where(eq(classTemplatePlans.templateId, c.req.param('id')));
    if (planIds.length > 0) {
      await db.insert(classTemplatePlans).values(
        (planIds as string[]).map((pid) => ({ templateId: c.req.param('id'), planTypeId: pid }))
      ).onConflictDoNothing();
    }
  }
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
    // activo=true: oculta sesiones de plantillas ya borradas (no aparecen en el calendario)
    .where(and(eq(classTemplates.activo, true), gte(classSessions.fecha, from), lte(classSessions.fecha, to)))
    .orderBy(classSessions.fecha, classTemplates.horaInicio);

  const filtered = trainingSlug ? rows.filter((r) => r.trainingSlug === trainingSlug) : rows;
  return c.json({ sessions: filtered });
});

classesRouter.post('/sessions/:id/cancel', requireStaff, async (c) => {
  const me = c.get('user');
  const { motivo } = await c.req.json().catch(() => ({ motivo: undefined }));
  const sessionId = c.req.param('id');

  // Usuarios a notificar (capturados antes de cancelar sus reservas)
  const activeBookings = await db
    .select({ userId: bookings.userId })
    .from(bookings)
    .where(and(eq(bookings.sessionId, sessionId), eq(bookings.estado, 'activa')));

  // Cancelar la sesión y sus reservas activas de forma atómica:
  // antes los bookings quedaban 'activa' apuntando a una sesión cancelada.
  await db.transaction(async (tx) => {
    await tx
      .update(classSessions)
      .set({ estado: 'cancelada', cancelacionMotivo: motivo, canceladaPor: me.sub })
      .where(eq(classSessions.id, sessionId));
    await tx
      .update(bookings)
      .set({ estado: 'cancelada', canceladaPor: me.rol === 'coach' ? 'coach' : 'admin', canceladaAt: new Date() })
      .where(and(eq(bookings.sessionId, sessionId), eq(bookings.estado, 'activa')));
  });

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

// Editar hora/capacidad vía la plantilla de una sesión (afecta sesiones futuras del mismo template)
classesRouter.patch('/sessions/:id', requireAdmin, async (c) => {
  const { horaInicio, capacidadMax } = await c.req.json().catch(() => ({}));
  // Obtener templateId de la sesión
  const [session] = await db.select({ templateId: classSessions.templateId }).from(classSessions).where(eq(classSessions.id, c.req.param('id')));
  if (!session) return c.json({ error: 'not_found' }, 404);
  const updates: Record<string, unknown> = {};
  if (horaInicio) {
    const t = String(horaInicio).slice(0, 5);
    updates.horaInicio = t;
  }
  if (capacidadMax !== undefined) updates.capacidadMax = capacidadMax;
  if (Object.keys(updates).length === 0) return c.json({ ok: true });
  await db.update(classTemplates).set(updates as any).where(eq(classTemplates.id, session.templateId));
  return c.json({ ok: true });
});

// Limpiar sesiones futuras (zona de peligro).
// IMPORTANTE: debe ir ANTES de /sessions/:id — si no, Hono toma 'clear' como :id
// (no es UUID) y la query falla con error 500.
classesRouter.delete('/sessions/clear', requireAdmin, async (c) => {
  const mes = c.req.query('mes'); // formato 'yyyy-MM', opcional
  const today = new Date().toISOString().slice(0, 10);

  let deleted: { id: string }[];
  if (mes) {
    const from = `${mes}-01`;
    const lastDay = new Date(Number(mes.slice(0, 4)), Number(mes.slice(5, 7)), 0).getDate();
    const to = `${mes}-${String(lastDay).padStart(2, '0')}`;
    deleted = await db
      .delete(classSessions)
      .where(and(eq(classSessions.estado, 'programada'), gte(classSessions.fecha, from), lte(classSessions.fecha, to)))
      .returning({ id: classSessions.id });
  } else {
    deleted = await db
      .delete(classSessions)
      .where(and(eq(classSessions.estado, 'programada'), gte(classSessions.fecha, today)))
      .returning({ id: classSessions.id });
  }

  return c.json({ deleted: deleted.length });
});

// Eliminar una sesión específica
classesRouter.delete('/sessions/:id', requireAdmin, async (c) => {
  await db.delete(classSessions).where(eq(classSessions.id, c.req.param('id')));
  return c.json({ ok: true });
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
