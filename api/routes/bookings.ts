import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc, sql, inArray, gte } from 'drizzle-orm';
import { db } from '../db/client';
import {
  bookings,
  classSessions,
  classTemplates,
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

// Crear reserva
bookingsRouter.post('/', zValidator('json', createSchema), async (c) => {
  const me = c.get('user');
  const { sessionId } = c.req.valid('json');

  // 1. Validar plan activo y acceso al training
  const planRows = await db
    .select({
      userPlanId: userPlans.id,
      estado: userPlans.estado,
      sesionesTotales: userPlans.sesionesTotales,
      sesionesUsadas: userPlans.sesionesUsadas,
      trainingTypeId: planTypes.trainingTypeId,
      accesoMulti: trainingTypes.accesoMulti,
      trainingSlug: trainingTypes.slug,
    })
    .from(userPlans)
    .innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
    .innerJoin(trainingTypes, eq(planTypes.trainingTypeId, trainingTypes.id))
    .where(and(eq(userPlans.userId, me.sub), eq(userPlans.estado, 'activo')))
    .limit(1);
  const plan = planRows[0];
  if (!plan) return c.json({ error: 'sin_plan_activo' }, 403);

  // 2. Validar sesión y cupos
  const sessRows = await db
    .select({
      id: classSessions.id,
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

  // 3. Acceso al training: VIP accede a todo excepto kids; resto solo a su training
  if (sess.trainingSlug === 'kids') return c.json({ error: 'kids_solo_por_admin' }, 403);
  if (!plan.accesoMulti && plan.trainingTypeId !== sess.trainingTypeId) {
    return c.json({ error: 'plan_no_cubre_training' }, 403);
  }

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

  // 5. Cupos
  if (sess.ocupados >= sess.capacidadMax) {
    // entrar a waitlist
    const pos = sess.ocupados - sess.capacidadMax + 1;
    await db.insert(waitlist).values({ userId: me.sub, sessionId, posicion: pos }).onConflictDoNothing();
    return c.json({ waitlisted: true, posicion: pos }, 202);
  }

  const [row] = await db
    .insert(bookings)
    .values({ userId: me.sub, sessionId, estado: 'activa' })
    .returning({ id: bookings.id });
  return c.json({ bookingId: row.id });
});

// Cancelar reserva
bookingsRouter.post('/:id/cancel', async (c) => {
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

  await db
    .update(bookings)
    .set({ estado: 'cancelada', canceladaPor: me.rol === 'user' ? 'usuario' : me.rol === 'coach' ? 'coach' : 'admin', canceladaAt: new Date() })
    .where(eq(bookings.id, id));

  // promover waitlist
  const wl = await db
    .select()
    .from(waitlist)
    .where(eq(waitlist.sessionId, b.sessionId))
    .orderBy(waitlist.posicion)
    .limit(1);
  if (wl[0]) {
    await db.delete(waitlist).where(eq(waitlist.id, wl[0].id));
    await db.insert(bookings).values({ userId: wl[0].userId, sessionId: b.sessionId, estado: 'activa' });
    notifyUser(wl[0].userId, {
      title: '¡Hay un cupo para tu clase! 🎉',
      body: 'Pasaste de la lista de espera a confirmado.',
      url: '/app/horarios',
    }, { tipo: 'reserva' }).catch(() => {});
  }

  return c.json({ ok: true, fueraDeVentana });
});
