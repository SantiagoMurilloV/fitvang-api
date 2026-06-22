import { Hono } from 'hono';
import { eq, sql, and, gte, lte } from 'drizzle-orm';
import { startOfMonth, endOfMonth, format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { db } from '../db/client';
import {
  users,
  bookings,
  payments,
  userPlans,
  classSessions,
} from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { requireAdmin, requireStaff } from '../middleware/rbac';
import { computeUserScoring } from '../services/scoring.service';

export const statsRouter = new Hono();
statsRouter.use('*', requireAuth);

// Mi scoring
statsRouter.get('/me/scoring', async (c) => {
  const me = c.get('user');
  const mes = c.req.query('mes');
  const data = await computeUserScoring(me.sub, mes);
  return c.json(data);
});

// Scoring de otro usuario (coach/admin)
statsRouter.get('/:id/scoring', requireStaff, async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  if (me.rol === 'user') return c.json({ error: 'forbidden' }, 403);
  const mes = c.req.query('mes');
  const data = await computeUserScoring(id, mes);
  return c.json(data);
});

// Historial de asistencias por día (para grid tipo GitHub, últimos N días)
statsRouter.get('/me/heatmap', async (c) => {
  const me = c.get('user');
  const days = Math.min(Number(c.req.query('days') ?? 84), 365);
  // Buscar bookings con estado asistio en los últimos `days` días
  const rows = await db
    .select({ fecha: classSessions.fecha })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .where(and(
      eq(bookings.userId, me.sub),
      eq(bookings.estado, 'asistio'),
      gte(classSessions.fecha, sql`(CURRENT_DATE - ${days}::int)::date::text`),
    ));

  // Agrupar por fecha: { 'yyyy-MM-dd': count }
  const map: Record<string, number> = {};
  for (const r of rows) {
    map[r.fecha] = (map[r.fecha] ?? 0) + 1;
  }
  return c.json({ heatmap: map });
});

// Mi recorrido (timeline)
statsRouter.get('/me/journey', async (c) => {
  const me = c.get('user');
  const userRow = await db.select({ createdAt: users.createdAt, nombre: users.nombreCompleto }).from(users).where(eq(users.id, me.sub)).limit(1);
  const totalAsistencias = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(eq(bookings.userId, me.sub), eq(bookings.estado, 'asistio')));
  const planes = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userPlans)
    .where(eq(userPlans.userId, me.sub));
  return c.json({
    inicio: userRow[0]?.createdAt ?? null,
    nombre: userRow[0]?.nombre ?? null,
    asistencias: totalAsistencias[0]?.n ?? 0,
    planes: planes[0]?.n ?? 0,
  });
});

// Dashboard admin KPIs
statsRouter.get('/admin/overview', requireAdmin, async (c) => {
  const now = toZonedTime(new Date(), 'America/Bogota');
  const inicioMes = format(startOfMonth(now), 'yyyy-MM-dd');
  const finMes = format(endOfMonth(now), 'yyyy-MM-dd');
  const today = format(now, 'yyyy-MM-dd');

  const activos = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(and(eq(users.activo, true), eq(users.rol, 'user')));
  const planesActivos = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(userPlans)
    .where(eq(userPlans.estado, 'activo'));
  const ingresosMes = await db
    .select({ total: sql<number>`COALESCE(SUM(${payments.montoCop}), 0)::bigint` })
    .from(payments)
    .where(and(eq(payments.estado, 'exitoso'), gte(payments.createdAt, new Date(inicioMes)), lte(payments.createdAt, new Date(finMes + 'T23:59:59'))));
  const clasesHoy = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(classSessions)
    .where(and(eq(classSessions.fecha, today), eq(classSessions.estado, 'programada')));

  return c.json({
    usuariosActivos: activos[0]?.n ?? 0,
    planesActivos: planesActivos[0]?.n ?? 0,
    ingresosMesCop: Number(ingresosMes[0]?.total ?? 0),
    clasesHoy: clasesHoy[0]?.n ?? 0,
  });
});
