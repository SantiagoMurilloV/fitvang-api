// Rutas de cron jobs — invocadas por Vercel Cron (vercel.json).
// Protegidas por CRON_SECRET en el header Authorization.
// Patrón idéntico a Bullfit: inactividad (lunes 9am) + vencimiento (diario 9am).
//
// Vercel Cron invoca con: Authorization: Bearer <CRON_SECRET>
// Los jobs nunca lanzan — loguean y devuelven siempre 200.

import { Hono } from 'hono';
import { eq, and, gt, desc } from 'drizzle-orm';
import { format, addDays } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { db } from '../db/client';
import { users, userPlans, planTypes, notifications, bookings, classSessions } from '../db/schema';
import { notifyUser } from '../services/webpush.service';
import { businessDaysSince } from '../lib/colombianHolidays';
import { generateUpcomingSessions, closeFinishedSessions } from '../services/scheduler.service';

const TZ = 'America/Bogota';

export const jobsRouter = new Hono();

// ─── Guard de CRON_SECRET ────────────────────────────────────────────────────
jobsRouter.use('*', async (c, next) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = c.req.header('Authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (token !== cronSecret) {
      return c.json({ error: 'unauthorized' }, 401);
    }
  }
  return next();
});

// ─── Mensajes de inactividad — 6 variantes deterministas (no random) ─────────
const INACTIVITY_MESSAGES = [
  {
    title: '¡Tu cuerpo te extraña! 💪',
    body: (name: string, days: number) =>
      `${name}, llevas ${days} días hábiles sin entrenar. Hoy es el mejor día para volver.`,
  },
  {
    title: 'La racha te espera 🔥',
    body: (name: string, days: number) =>
      `${name}, ${days} días sin Fitvang. ¡Un solo entrenamiento cambia todo!`,
  },
  {
    title: 'Fitvang te necesita 🏋️',
    body: (name: string, days: number) =>
      `Han pasado ${days} días hábiles, ${name}. Tu espacio en el gym te está esperando.`,
  },
  {
    title: '¿Todo bien? Te echamos de menos 👀',
    body: (name: string, days: number) =>
      `${name}, ${days} días sin verte por aquí. ¡Vuelve y recupera tu racha!`,
  },
  {
    title: 'Semana nueva, nueva oportunidad 🚀',
    body: (name: string, days: number) =>
      `${name}, esta semana es tuya. Llevas ${days} días sin entrenar — ¡rómpela hoy!`,
  },
  {
    title: 'No dejes que el hábito se enfríe ❄️➡️🔥',
    body: (name: string, days: number) =>
      `${days} días hábiles sin Fitvang, ${name}. Cada sesión cuenta para tu racha.`,
  },
];

// Variante determinista por userId+semana — mismo mensaje reproducible, varía con el tiempo
function pickMessage(userId: string, weekNumber: number) {
  const seed = userId.charCodeAt(userId.length - 1) + weekNumber;
  return INACTIVITY_MESSAGES[seed % INACTIVITY_MESSAGES.length];
}

function isoWeek(date: Date): number {
  const jan4 = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const start = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 86400000);
  return Math.floor((date.getTime() - start.getTime()) / (7 * 86400000)) + 1;
}

function isoWeekStr(date: Date): string {
  const d = toZonedTime(date, TZ);
  const wk = isoWeek(d);
  return `${d.getFullYear()}-W${String(wk).padStart(2, '0')}`;
}

// ─── Job: Inactividad ─────────────────────────────────────────────────────────
// Vercel Cron: '0 14 * * 1'  (lunes 14:00 UTC = 09:00 Bogotá)
jobsRouter.post('/inactividad', async (c) => {
  const now = toZonedTime(new Date(), TZ);
  const isoWk = isoWeekStr(now);
  const weekNumber = isoWeek(now);

  console.log(`[job/inactividad] Iniciando semana ${isoWk}`);

  let notified = 0;
  let skipped = 0;

  try {
    // Usuarios activos con plan vigente
    const activeUsers = await db
      .select({
        id: users.id,
        nombre: users.nombreCompleto,
      })
      .from(users)
      .where(and(eq(users.activo, true), eq(users.rol, 'user')));

    for (const u of activeUsers) {
      const dedupeKey = `inactividad-${u.id}-${isoWk}`;

      // ¿Ya notificado esta semana?
      const alreadySent = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.dedupeKey, dedupeKey))
        .limit(1);
      if (alreadySent[0]) { skipped++; continue; }

      // Última asistencia
      const lastRows = await db
        .select({ fecha: classSessions.fecha })
        .from(bookings)
        .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
        .where(and(eq(bookings.userId, u.id), eq(bookings.estado, 'asistio')))
        .orderBy(desc(classSessions.fecha))
        .limit(1);

      let daysSince: number;
      if (!lastRows[0]) {
        daysSince = 5; // sin asistencias — siempre inactivo
      } else {
        daysSince = businessDaysSince(lastRows[0].fecha);
      }

      if (daysSince < 4) { skipped++; continue; }

      const firstName = u.nombre.split(' ')[0] ?? 'campeón';
      const variant = pickMessage(u.id, weekNumber);

      await notifyUser(
        u.id,
        { title: variant.title, body: variant.body(firstName, daysSince), url: '/app/horarios' },
        { tipo: 'asistencia', dedupeKey },
      );

      notified++;
    }

    console.log(`[job/inactividad] Notificados: ${notified}, Saltados: ${skipped}`);
    return c.json({ ok: true, notified, skipped, week: isoWk });
  } catch (err) {
    console.error('[job/inactividad] Error:', err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// ─── Job: Vencimiento de plan ─────────────────────────────────────────────────
// Vercel Cron: '0 14 * * *'  (diario 14:00 UTC = 09:00 Bogotá)
jobsRouter.post('/vencimiento', async (c) => {
  const now = toZonedTime(new Date(), TZ);
  const target = format(addDays(now, 2), 'yyyy-MM-dd'); // vence en 2 días

  console.log(`[job/vencimiento] Buscando planes que vencen el ${target}`);

  let notified = 0;
  let skipped = 0;

  try {
    // Planes que vencen exactamente en 2 días
    const expiring = await db
      .select({
        planId: userPlans.id,
        userId: userPlans.userId,
        nombre: users.nombreCompleto,
        fechaFin: userPlans.fechaFin,
        planNombre: planTypes.nombre,
      })
      .from(userPlans)
      .innerJoin(users, eq(userPlans.userId, users.id))
      .innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
      .where(and(eq(userPlans.estado, 'activo'), eq(userPlans.fechaFin, target)));

    for (const plan of expiring) {
      const dedupeKey = `vencimiento-${plan.planId}-${target}`;

      // ¿Ya notificado?
      const alreadySent = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(eq(notifications.dedupeKey, dedupeKey))
        .limit(1);
      if (alreadySent[0]) { skipped++; continue; }

      // ¿Ya renovó? (existe un plan activo con fecha de fin posterior)
      const renewed = await db
        .select({ id: userPlans.id })
        .from(userPlans)
        .where(and(
          eq(userPlans.userId, plan.userId),
          eq(userPlans.estado, 'activo'),
          gt(userPlans.fechaFin, target),
        ))
        .limit(1);
      if (renewed[0]) { skipped++; continue; }

      const firstName = plan.nombre.split(' ')[0] ?? '';
      const greeting = firstName ? `${firstName}, ` : '';

      // Formato de fecha legible
      const [, mesNum, dia] = target.split('-');
      const meses = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
      const fechaLegible = `${Number(dia)} de ${meses[Number(mesNum) - 1]}`;

      await notifyUser(
        plan.userId,
        {
          title: 'Tu plan está por vencer ⏳',
          body: `${greeting}tu ${plan.planNombre} vence el ${fechaLegible}. Renuévalo para mantener el ritmo que traes. ¡En Fitvang te esperamos! 💪`,
          url: '/app/pagos',
        },
        { tipo: 'sistema', dedupeKey },
      );

      notified++;
    }

    console.log(`[job/vencimiento] Notificados: ${notified}, Saltados: ${skipped}`);
    return c.json({ ok: true, notified, skipped, target });
  } catch (err) {
    console.error('[job/vencimiento] Error:', err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// ─── Job: Generar sesiones futuras ────────────────────────────────────────────
// Vercel Cron: '0 5 * * *'  (diario 05:00 UTC = 00:00 Bogotá)
jobsRouter.post('/generar-sesiones', async (c) => {
  try {
    const inserted = await generateUpcomingSessions(30);
    console.log(`[job/generar-sesiones] Insertadas: ${inserted}`);
    return c.json({ ok: true, inserted });
  } catch (err) {
    console.error('[job/generar-sesiones] Error:', err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
});

// ─── Job: Cerrar sesiones finalizadas ─────────────────────────────────────────
// Vercel Cron: '30 5 * * *'  (diario 05:30 UTC = 00:30 Bogotá)
jobsRouter.post('/cerrar-sesiones', async (c) => {
  try {
    const closed = await closeFinishedSessions();
    console.log(`[job/cerrar-sesiones] Cerradas: ${closed}`);
    return c.json({ ok: true, closed });
  } catch (err) {
    console.error('[job/cerrar-sesiones] Error:', err);
    return c.json({ ok: false, error: String(err) }, 500);
  }
});
