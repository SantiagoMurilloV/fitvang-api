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
import { analyzeFinances } from '../services/agent.service';

const TZ = 'America/Bogota';

// Desglose financiero por mes (últimos 12), agrupado en JS para no depender del driver.
async function buildFinanzas() {
  const rows = await db
    .select({ monto: payments.montoCop, estado: payments.estado, metodo: payments.metodo, createdAt: payments.createdAt })
    .from(payments);
  const map = new Map<string, { mes: string; ingresos: number; pagos: number; pendiente: number; pendientes: number }>();
  let totalIngresos = 0;
  let totalPendiente = 0;
  let totalPendientes = 0;
  for (const r of rows) {
    const mes = format(toZonedTime(r.createdAt as Date, TZ), 'yyyy-MM');
    const m = map.get(mes) ?? { mes, ingresos: 0, pagos: 0, pendiente: 0, pendientes: 0 };
    if (r.estado === 'exitoso') { m.ingresos += r.monto; m.pagos += 1; totalIngresos += r.monto; }
    if (r.estado === 'pendiente') { m.pendiente += r.monto; m.pendientes += 1; totalPendiente += r.monto; totalPendientes += 1; }
    map.set(mes, m);
  }
  const meses = [...map.values()].sort((a, b) => (a.mes < b.mes ? 1 : -1)).slice(0, 12);
  return { meses, totales: { ingresos: totalIngresos, pendiente: totalPendiente, pendientes: totalPendientes } };
}

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
      gte(classSessions.fecha, sql`(CURRENT_DATE - ${days}::int)::date`),
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
  // Las 3 queries son independientes → en paralelo en vez de secuencial
  const [userRow, totalAsistencias, planes] = await Promise.all([
    db.select({ createdAt: users.createdAt, nombre: users.nombreCompleto }).from(users).where(eq(users.id, me.sub)).limit(1),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookings)
      .where(and(eq(bookings.userId, me.sub), eq(bookings.estado, 'asistio'))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(userPlans)
      .where(eq(userPlans.userId, me.sub)),
  ]);
  return c.json({
    inicio: userRow[0]?.createdAt ?? null,
    nombre: userRow[0]?.nombre ?? null,
    asistencias: totalAsistencias[0]?.n ?? 0,
    planes: planes[0]?.n ?? 0,
  });
});

// Roster de estudiantes (miembros + niños, sin acudientes) con su scoring.
// Para el panel de "Progreso de estudiantes" del admin/coach.
statsRouter.get('/students', requireStaff, async (c) => {
  const roster = await db
    .select({
      id: users.id,
      nombre: users.nombreCompleto,
      avatarUrl: users.avatarUrl,
      esMenor: users.esMenor,
    })
    .from(users)
    .where(and(eq(users.rol, 'user'), eq(users.esAcudiente, false), eq(users.activo, true)))
    .orderBy(users.nombreCompleto);

  // Scoring por usuario (2 queries c/u). El club es pequeño; si crece, cachear.
  const students = await Promise.all(
    roster.map(async (u) => {
      const s = await computeUserScoring(u.id);
      return {
        ...u,
        rachaActual: s.rachaActual,
        rachaMaxima: s.rachaMaxima,
        asistencias: s.asistencias,
        totalSesiones: s.totalSesiones,
        porcentaje: s.porcentaje,
        nivel: s.nivel,
      };
    }),
  );
  return c.json({ students });
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

// Análisis financiero (admin): datos por mes + totales
statsRouter.get('/finanzas', requireAdmin, async (c) => {
  const data = await buildFinanzas();
  return c.json(data);
});

// Conclusiones del agente IA sobre las finanzas
statsRouter.get('/finanzas/analisis', requireAdmin, async (c) => {
  const data = await buildFinanzas();
  const analisis = await analyzeFinances(data.meses);
  return c.json({ analisis });
});
