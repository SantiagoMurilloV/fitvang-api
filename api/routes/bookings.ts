import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, sql, inArray, gte, gt } from 'drizzle-orm';
import { db } from '../db/client';
import {
  bookings,
  classSessions,
  classTemplates,
  classTemplatePlans,
  trainingTypes,
  userPlans,
  planTypes,
  waitlist,
  clubConfig,
} from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { checkSelf } from '../middleware/rbac';
import { notifyUser } from '../services/webpush.service';
import { toZonedTime } from 'date-fns-tz';
import { format, differenceInMinutes, parseISO } from 'date-fns';

export const bookingsRouter = new Hono();
bookingsRouter.use('*', requireAuth);

const createSchema = z.object({ sessionId: z.string().uuid() });

const TZ_BOG = 'America/Bogota';

// Elige un plan ACTIVO del usuario que cubra la sesión (training + restricción
// explícita por plan en class_template_plans) y que tenga cupo de sesiones.
// Soporta múltiples planes activos por usuario. Devuelve el plan o un código error.
async function resolvePlanForSession(
  userId: string,
  sess: { templateId: string; trainingTypeId: string },
): Promise<{ plan?: { userPlanId: string; planTypeId: string }; error?: string }> {
  const planRows = await db
    .select({
      userPlanId: userPlans.id,
      planTypeId: userPlans.planTypeId,
      trainingTypeId: planTypes.trainingTypeId,
      accesoMulti: trainingTypes.accesoMulti,
      sesionesTotales: userPlans.sesionesTotales,
      sesionesUsadas: userPlans.sesionesUsadas,
    })
    .from(userPlans)
    .innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
    .innerJoin(trainingTypes, eq(planTypes.trainingTypeId, trainingTypes.id))
    .where(and(eq(userPlans.userId, userId), eq(userPlans.estado, 'activo')));
  if (planRows.length === 0) return { error: 'sin_plan_activo' };

  const tplPlans = await db
    .select({ planTypeId: classTemplatePlans.planTypeId })
    .from(classTemplatePlans)
    .where(eq(classTemplatePlans.templateId, sess.templateId));
  const allowed = new Set(tplPlans.map((p) => p.planTypeId));

  const covering = planRows.filter(
    (p) =>
      (p.accesoMulti || p.trainingTypeId === sess.trainingTypeId) &&
      (allowed.size === 0 || allowed.has(p.planTypeId)),
  );
  if (covering.length === 0) return { error: 'plan_no_cubre_training' };

  const usable = covering.find((p) => p.sesionesTotales == null || p.sesionesUsadas < p.sesionesTotales);
  if (!usable) return { error: 'plan_sin_sesiones' };
  return { plan: { userPlanId: usable.userPlanId, planTypeId: usable.planTypeId } };
}

// Mis reservas
bookingsRouter.get('/me', async (c) => {
  const me = c.get('user');
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      bookingId: bookings.id,
      estado: bookings.estado,
      sessionId: classSessions.id,
      fecha: classSessions.fecha,
      sessionEstado: classSessions.estado,
      horaInicio: classTemplates.horaInicio,
      horaFin: classTemplates.horaFin,
      nombre: classTemplates.nombre,
      trainingSlug: trainingTypes.slug,
      trainingColor: trainingTypes.colorHex,
    })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .innerJoin(trainingTypes, eq(classTemplates.trainingTypeId, trainingTypes.id))
    .where(and(eq(bookings.userId, me.sub), gte(classSessions.fecha, today)))
    .orderBy(classSessions.fecha, classTemplates.horaInicio);
  return c.json({ bookings: rows });
});

// Reservas de un usuario — accesible por el propio usuario, su acudiente o admin/coach
bookingsRouter.get('/user/:id', async (c) => {
  const me = c.get('user');
  const userId = c.req.param('id');
  const isStaff = me.rol === 'super_admin' || me.rol === 'coach';
  const isSelf = me.sub === userId;

  if (!isStaff && !isSelf) {
    // Verificar que el llamante es acudiente del menor
    const { guardians } = await import('../db/schema');
    const { eq: eqG, and: andG } = await import('drizzle-orm');
    const rel = await db
      .select({ id: guardians.id })
      .from(guardians)
      .where(andG(eqG(guardians.acudienteId, me.sub), eqG(guardians.menorId, userId)))
      .limit(1);
    if (!rel[0]) return c.json({ error: 'forbidden' }, 403);
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = await db
    .select({
      bookingId: bookings.id,
      estado: bookings.estado,
      sessionId: classSessions.id,
      fecha: classSessions.fecha,
      sessionEstado: classSessions.estado,
      horaInicio: classTemplates.horaInicio,
      horaFin: classTemplates.horaFin,
      nombre: classTemplates.nombre,
      trainingColor: trainingTypes.colorHex,
    })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .innerJoin(trainingTypes, eq(classTemplates.trainingTypeId, trainingTypes.id))
    .where(and(eq(bookings.userId, userId), gte(classSessions.fecha, today)))
    .orderBy(classSessions.fecha, classTemplates.horaInicio);
  return c.json({ bookings: rows });
});

// Crear reserva
bookingsRouter.post('/', zValidator('json', createSchema), async (c) => {
  const me = c.get('user');
  const { sessionId } = c.req.valid('json');

  // 1. Validar sesión y cupos
  const sessRows = await db
    .select({
      id: classSessions.id,
      templateId: classSessions.templateId,
      estado: classSessions.estado,
      fecha: classSessions.fecha,
      horaInicio: classTemplates.horaInicio,
      trainingTypeId: classTemplates.trainingTypeId,
      trainingSlug: trainingTypes.slug,
      capacidadMax: classTemplates.capacidadMax,
      ocupados: sql<number>`COALESCE((SELECT COUNT(*)::int FROM ${bookings} b WHERE b.session_id = ${classSessions.id} AND b.estado IN ('activa','asistio'))::int, 0)`,
    })
    .from(classSessions)
    .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .innerJoin(trainingTypes, eq(classTemplates.trainingTypeId, trainingTypes.id))
    .where(eq(classSessions.id, sessionId))
    .limit(1);
  const sess = sessRows[0];
  if (!sess) return c.json({ error: 'sesion_no_encontrada' }, 404);
  if (sess.estado !== 'programada') return c.json({ error: 'sesion_no_disponible' }, 400);

  // 2. Clases Kids: solo el admin inscribe
  if (sess.trainingSlug === 'kids') return c.json({ error: 'kids_solo_por_admin' }, 403);

  // ── Reglas de tiempo (igual que Bullfit) ──────────────────────────────
  const nowBog = toZonedTime(new Date(), TZ_BOG);
  const hourBog = nowBog.getHours();
  // Ventana nocturna: no reservar entre 23:00 y 05:59 (hora Bogotá)
  if (hourBog >= 23 || hourBog < 6) {
    return c.json({ error: 'horario_restringido', message: 'No puedes reservar entre las 11 PM y las 6 AM.' }, 400);
  }
  // Mínimo 30 minutos de anticipación
  const sessionStart = parseISO(`${sess.fecha}T${sess.horaInicio}`);
  const minutosRestantes = differenceInMinutes(sessionStart, nowBog);
  if (minutosRestantes < 30) {
    return c.json({ error: 'muy_tarde_para_reservar', message: 'Debes reservar con al menos 30 minutos de anticipación.' }, 400);
  }

  // 4. Doble reserva
  const dup = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.userId, me.sub), eq(bookings.sessionId, sessionId), inArray(bookings.estado, ['activa', 'asistio'])))
    .limit(1);
  if (dup[0]) return c.json({ error: 'ya_reservada' }, 409);

  // 5. Elegir un plan activo que cubra la clase y tenga cupo de sesiones
  const resolved = await resolvePlanForSession(me.sub, sess);
  if (resolved.error) {
    const msg = resolved.error === 'plan_sin_sesiones' ? 'Tu plan no tiene sesiones disponibles.' : undefined;
    return c.json(msg ? { error: resolved.error, message: msg } : { error: resolved.error }, 403);
  }
  const usable = resolved.plan!;

  // 6. Cupos
  if (sess.ocupados >= sess.capacidadMax) {
    // entrar a waitlist (no consume sesión hasta ser promovido)
    const pos = sess.ocupados - sess.capacidadMax + 1;
    await db.insert(waitlist).values({ userId: me.sub, sessionId, posicion: pos }).onConflictDoNothing();
    return c.json({ waitlisted: true, posicion: pos }, 202);
  }

  // Reserva + consumo de una sesión del plan de forma atómica.
  // onConflictDoUpdate reactiva una reserva previamente cancelada (mismo userId+sessionId).
  const bookingId = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(bookings)
      .values({ userId: me.sub, sessionId, estado: 'activa' })
      .onConflictDoUpdate({
        target: [bookings.userId, bookings.sessionId],
        set: { estado: 'activa', canceladaPor: null, canceladaAt: null, fechaReserva: new Date() },
      })
      .returning({ id: bookings.id });
    await tx
      .update(userPlans)
      .set({ sesionesUsadas: sql`${userPlans.sesionesUsadas} + 1` })
      .where(eq(userPlans.id, usable.userPlanId));
    return row.id;
  });
  return c.json({ bookingId });
});

// Cancelar reserva
// DELETE = cancelar la reserva (soft: estado 'cancelada' + devuelve cupo + promueve lista)
bookingsRouter.delete('/:id', async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const rows = await db
    .select({
      booking: bookings,
      fecha: classSessions.fecha,
      horaInicio: classTemplates.horaInicio,
      sessionId: classSessions.id,
    })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .where(eq(bookings.id, id))
    .limit(1);
  const b = rows[0];
  if (!b) return c.json({ error: 'not_found' }, 404);
  if (b.booking.userId !== me.sub && me.rol === 'user') return c.json({ error: 'forbidden' }, 403);

  // ventana mínima de cancelación
  const cfg = await db.select().from(clubConfig).limit(1);
  const horasMin = cfg[0]?.cancelacionHorasMin ?? 2;
  const sessAt = new Date(`${b.fecha}T${b.horaInicio}-05:00`);
  const horasFalta = (sessAt.getTime() - Date.now()) / 36e5;
  const fueraDeVentana = horasFalta < horasMin;

  const canceladaPor = me.rol === 'user' ? 'usuario' : me.rol === 'coach' ? 'coach' : 'admin';
  const consumioSesion = b.booking.estado === 'activa' || b.booking.estado === 'asistio';

  let promovido: string | null = null;
  await db.transaction(async (tx) => {
    await tx
      .update(bookings)
      .set({ estado: 'cancelada', canceladaPor, canceladaAt: new Date() })
      .where(eq(bookings.id, id));

    // Devolver la sesión al plan activo del usuario (si la reserva la consumía)
    if (consumioSesion) {
      await tx
        .update(userPlans)
        .set({ sesionesUsadas: sql`GREATEST(0, ${userPlans.sesionesUsadas} - 1)` })
        .where(and(eq(userPlans.userId, b.booking.userId), eq(userPlans.estado, 'activo')));
    }

    // Promover al primero de la lista de espera
    const wl = await tx
      .select()
      .from(waitlist)
      .where(eq(waitlist.sessionId, b.sessionId))
      .orderBy(waitlist.posicion)
      .limit(1);
    if (wl[0]) {
      await tx.delete(waitlist).where(eq(waitlist.id, wl[0].id));
      // Reordenar: los que estaban detrás suben una posición (antes quedaban desfasados)
      await tx
        .update(waitlist)
        .set({ posicion: sql`${waitlist.posicion} - 1` })
        .where(and(eq(waitlist.sessionId, b.sessionId), gt(waitlist.posicion, wl[0].posicion)));
      // Crear/activar la reserva del promovido
      await tx
        .insert(bookings)
        .values({ userId: wl[0].userId, sessionId: b.sessionId, estado: 'activa' })
        .onConflictDoUpdate({
          target: [bookings.userId, bookings.sessionId],
          set: { estado: 'activa', canceladaPor: null, canceladaAt: null, fechaReserva: new Date() },
        });
      // El promovido consume una sesión de su plan activo
      await tx
        .update(userPlans)
        .set({ sesionesUsadas: sql`${userPlans.sesionesUsadas} + 1` })
        .where(and(eq(userPlans.userId, wl[0].userId), eq(userPlans.estado, 'activo')));
      promovido = wl[0].userId;
    }
  });

  if (promovido) {
    notifyUser(promovido, {
      title: '¡Hay un cupo para tu clase! 🎉',
      body: 'Pasaste de la lista de espera a confirmado.',
      url: '/app/horarios',
    }, { tipo: 'reserva' }).catch(() => {});
  }

  return c.json({ ok: true, fueraDeVentana });
});

// PUT = reagendar: mover una reserva a otra sesión (cancela la actual + reserva la
// nueva de forma atómica). Reglas: la reserva actual debe estar a ≥1h y la nueva
// sesión pasa las mismas validaciones que una reserva normal.
const rescheduleSchema = z.object({ newSessionId: z.string().uuid() });
bookingsRouter.put('/:id', zValidator('json', rescheduleSchema), async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const { newSessionId } = c.req.valid('json');

  // 1. Reserva actual
  const oldRows = await db
    .select({
      booking: bookings,
      fecha: classSessions.fecha,
      horaInicio: classTemplates.horaInicio,
      sessionId: classSessions.id,
    })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .where(eq(bookings.id, id))
    .limit(1);
  const old = oldRows[0];
  if (!old) return c.json({ error: 'not_found' }, 404);
  if (old.booking.userId !== me.sub && me.rol === 'user') return c.json({ error: 'forbidden' }, 403);
  if (old.booking.estado !== 'activa') return c.json({ error: 'reserva_no_activa' }, 400);
  if (newSessionId === old.sessionId) return c.json({ error: 'misma_sesion' }, 400);

  // La reserva actual debe poder modificarse con ≥1h de anticipación
  const oldStart = new Date(`${old.fecha}T${old.horaInicio}-05:00`);
  if ((oldStart.getTime() - Date.now()) / 36e5 < 1) {
    return c.json({ error: 'muy_tarde_para_editar', message: 'Solo puedes reagendar con al menos 1 hora de anticipación.' }, 400);
  }

  // 2. Nueva sesión
  const sessRows = await db
    .select({
      id: classSessions.id,
      templateId: classSessions.templateId,
      estado: classSessions.estado,
      fecha: classSessions.fecha,
      horaInicio: classTemplates.horaInicio,
      trainingTypeId: classTemplates.trainingTypeId,
      trainingSlug: trainingTypes.slug,
      capacidadMax: classTemplates.capacidadMax,
      ocupados: sql<number>`COALESCE((SELECT COUNT(*)::int FROM ${bookings} b WHERE b.session_id = ${classSessions.id} AND b.estado IN ('activa','asistio'))::int, 0)`,
    })
    .from(classSessions)
    .innerJoin(classTemplates, eq(classSessions.templateId, classTemplates.id))
    .innerJoin(trainingTypes, eq(classTemplates.trainingTypeId, trainingTypes.id))
    .where(eq(classSessions.id, newSessionId))
    .limit(1);
  const sess = sessRows[0];
  if (!sess) return c.json({ error: 'sesion_no_encontrada' }, 404);
  if (sess.estado !== 'programada') return c.json({ error: 'sesion_no_disponible' }, 400);
  if (sess.trainingSlug === 'kids') return c.json({ error: 'kids_solo_por_admin' }, 403);

  // Algún plan activo debe cubrir la nueva clase (multi-plan)
  const resolved = await resolvePlanForSession(old.booking.userId, { templateId: sess.templateId, trainingTypeId: sess.trainingTypeId });
  if (resolved.error) {
    const msg = resolved.error === 'plan_sin_sesiones' ? 'Tu plan no tiene sesiones disponibles.' : undefined;
    return c.json(msg ? { error: resolved.error, message: msg } : { error: resolved.error }, 403);
  }

  const nowBog = toZonedTime(new Date(), TZ_BOG);
  const hourBog = nowBog.getHours();
  if (hourBog >= 23 || hourBog < 6) {
    return c.json({ error: 'horario_restringido', message: 'No puedes reservar entre las 11 PM y las 6 AM.' }, 400);
  }
  const newStart = parseISO(`${sess.fecha}T${sess.horaInicio}`);
  if (differenceInMinutes(newStart, nowBog) < 30) {
    return c.json({ error: 'muy_tarde_para_reservar', message: 'La nueva clase debe ser con al menos 30 minutos de anticipación.' }, 400);
  }

  const dup = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(and(eq(bookings.userId, old.booking.userId), eq(bookings.sessionId, newSessionId), inArray(bookings.estado, ['activa', 'asistio'])))
    .limit(1);
  if (dup[0]) return c.json({ error: 'ya_reservada' }, 409);

  if (sess.ocupados >= sess.capacidadMax) return c.json({ error: 'sesion_llena', message: 'La clase elegida está llena.' }, 400);

  // 4. Swap atómico: el cupo es el mismo, así que no se toca el conteo del plan.
  let promovido: string | null = null;
  await db.transaction(async (tx) => {
    // Cancelar la reserva actual
    await tx
      .update(bookings)
      .set({ estado: 'cancelada', canceladaPor: 'usuario', canceladaAt: new Date() })
      .where(eq(bookings.id, id));

    // Promover al primero de la lista de espera de la sesión liberada
    const wl = await tx.select().from(waitlist).where(eq(waitlist.sessionId, old.sessionId)).orderBy(waitlist.posicion).limit(1);
    if (wl[0]) {
      await tx.delete(waitlist).where(eq(waitlist.id, wl[0].id));
      await tx.update(waitlist).set({ posicion: sql`${waitlist.posicion} - 1` }).where(and(eq(waitlist.sessionId, old.sessionId), gt(waitlist.posicion, wl[0].posicion)));
      await tx
        .insert(bookings)
        .values({ userId: wl[0].userId, sessionId: old.sessionId, estado: 'activa' })
        .onConflictDoUpdate({ target: [bookings.userId, bookings.sessionId], set: { estado: 'activa', canceladaPor: null, canceladaAt: null, fechaReserva: new Date() } });
      await tx.update(userPlans).set({ sesionesUsadas: sql`${userPlans.sesionesUsadas} + 1` }).where(and(eq(userPlans.userId, wl[0].userId), eq(userPlans.estado, 'activo')));
      promovido = wl[0].userId;
    }

    // Activar la reserva en la nueva sesión (reactiva si existía cancelada)
    await tx
      .insert(bookings)
      .values({ userId: old.booking.userId, sessionId: newSessionId, estado: 'activa' })
      .onConflictDoUpdate({ target: [bookings.userId, bookings.sessionId], set: { estado: 'activa', canceladaPor: null, canceladaAt: null, fechaReserva: new Date() } });
  });

  if (promovido) {
    notifyUser(promovido, {
      title: 'Hay un cupo para tu clase',
      body: 'Pasaste de la lista de espera a confirmado.',
      url: '/app/horarios',
    }, { tipo: 'reserva' }).catch(() => {});
  }

  return c.json({ ok: true });
});
