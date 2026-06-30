import { sql, eq, and, gte, lte } from 'drizzle-orm';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { db } from '../db/client';
import { bookings, classSessions, attendanceScoring, users } from '../db/schema';
import { isBusinessDay, businessDaysSince } from '../lib/colombianHolidays';
import { notifyUser } from './webpush.service';

const TZ = 'America/Bogota';

type Nivel = 'rookie' | 'regular' | 'constante' | 'elite' | 'leyenda';

function nivelFromPct(pct: number): Nivel {
  if (pct >= 95) return 'leyenda';
  if (pct >= 80) return 'elite';
  if (pct >= 60) return 'constante';
  if (pct >= 40) return 'regular';
  return 'rookie';
}

export interface UserScoring {
  mes: string;
  totalSesiones: number;
  asistencias: number;
  porcentaje: number;
  rachaActual: number;
  rachaMaxima: number;
  nivel: Nivel;
}

// ─── Helpers de racha (semanas completas, estilo Bullfit) ─────────────────────

function weekKey(dateStr: string): string {
  // YYYY-Www usando ISO week
  const d = new Date(dateStr + 'T12:00:00Z');
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const startOfWeekJan4 = new Date(jan4.getTime() - (jan4.getUTCDay() || 7) * 86400000 + 86400000);
  const weekNum = Math.floor((d.getTime() - startOfWeekJan4.getTime()) / (7 * 86400000)) + 1;
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function mondayOfWeek(wk: string): string {
  // Parsear "YYYY-Www" → lunes de esa semana
  const [yearStr, wStr] = wk.split('-W');
  const year = Number(yearStr);
  const week = Number(wStr);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4.getTime() - (jan4.getUTCDay() || 7) * 86400000 + 86400000);
  monday.setUTCDate(monday.getUTCDate() + (week - 1) * 7);
  return format(monday, 'yyyy-MM-dd');
}

function prevWeekKey(wk: string): string {
  const monday = mondayOfWeek(wk);
  const prev = new Date(monday + 'T12:00:00Z');
  prev.setUTCDate(prev.getUTCDate() - 7);
  return weekKey(format(prev, 'yyyy-MM-dd'));
}

// Una semana cuenta para la racha si tiene ≥3 asistencias en días hábiles
// (no exige que sean consecutivas). Excluye festivos (solo L–V).
function computeStreakFromDays(attendedDays: string[]): { rachaActual: number; rachaMaxima: number } {
  const today = format(toZonedTime(new Date(), TZ), 'yyyy-MM-dd');
  const todayWk = weekKey(today);

  // Agrupar días asistidos por semana (solo hábiles)
  const weekMap = new Map<string, Set<string>>();
  for (const day of attendedDays) {
    if (day > today || !isBusinessDay(day)) continue;
    const wk = weekKey(day);
    if (!weekMap.has(wk)) weekMap.set(wk, new Set());
    weekMap.get(wk)!.add(day);
  }

  if (weekMap.size === 0) return { rachaActual: 0, rachaMaxima: 0 };

  // ── Racha actual: hacia atrás desde semana actual ──
  let rachaActual = 0;
  let checkWk = todayWk;

  // Una semana cuenta para la racha si tiene ≥3 asistencias (días hábiles)
  const todaySet = weekMap.get(checkWk);
  if (todaySet && todaySet.size >= 3) {
    rachaActual++;
  }

  checkWk = prevWeekKey(checkWk);
  while (true) {
    const s = weekMap.get(checkWk);
    if (!s || s.size < 3) break;
    rachaActual++;
    checkWk = prevWeekKey(checkWk);
  }

  // ── Racha máxima histórica ──
  const sortedWeeks = [...weekMap.keys()].sort();
  let best = 0;
  let run = 0;
  let prevWk: string | null = null;
  for (const wk of sortedWeeks) {
    const s = weekMap.get(wk)!;
    const complete = s.size >= 3;
    const gap = prevWk ? wk !== weekKey(
      format(new Date(mondayOfWeek(prevWk) + 'T12:00:00Z'), 'yyyy-MM-dd').replace(
        /(\d{4}-\d{2}-\d{2})/,
        (m) => {
          const d = new Date(m + 'T12:00:00Z');
          d.setUTCDate(d.getUTCDate() + 7);
          return format(d, 'yyyy-MM-dd');
        },
      ),
    ) : false;
    if (!complete || gap) {
      if (run > best) best = run;
      run = complete ? 1 : 0;
    } else {
      run++;
    }
    prevWk = wk;
  }
  if (run > best) best = run;

  return { rachaActual, rachaMaxima: Math.max(best, rachaActual) };
}

// ─── API principal ────────────────────────────────────────────────────────────

export async function computeUserScoring(userId: string, mes?: string): Promise<UserScoring> {
  const now = toZonedTime(new Date(), TZ);
  const ref = mes ? new Date(mes + '-01T12:00:00Z') : now;
  const ini = format(startOfMonth(ref), 'yyyy-MM-dd');
  const fin = format(endOfMonth(ref), 'yyyy-MM-dd');
  const mesStr = format(ref, 'yyyy-MM');

  // Obtener todos los bookings del mes con su asistencia
  const rows = await db
    .select({
      fecha: classSessions.fecha,
      estado: bookings.estado,
    })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .where(
      and(
        eq(bookings.userId, userId),
        gte(classSessions.fecha, ini),
        lte(classSessions.fecha, fin),
      ),
    );

  const totalSesiones = rows.length;
  const asistencias = rows.filter((r) => r.estado === 'asistio').length;
  const porcentaje = totalSesiones === 0 ? 0 : Math.round((asistencias / totalSesiones) * 100);

  // Para la racha necesitamos los días asistidos, pero acotados al último año:
  // la racha máxima por semanas casi nunca requiere más historial y evita cargar
  // miles de filas por usuario antiguo en cada marcación de asistencia.
  const allAttended = await db
    .select({ fecha: classSessions.fecha })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .where(and(
      eq(bookings.userId, userId),
      eq(bookings.estado, 'asistio'),
      gte(classSessions.fecha, sql`(CURRENT_DATE - 370)::date`),
    ));

  const attendedDays = allAttended.map((r) => r.fecha);
  const { rachaActual, rachaMaxima } = computeStreakFromDays(attendedDays);

  return {
    mes: mesStr,
    totalSesiones,
    asistencias,
    porcentaje,
    rachaActual,
    rachaMaxima,
    nivel: nivelFromPct(porcentaje),
  };
}

export async function persistScoring(userId: string): Promise<UserScoring> {
  const s = await computeUserScoring(userId);
  await db
    .insert(attendanceScoring)
    .values({ userId, ...s })
    .onConflictDoUpdate({
      target: [attendanceScoring.userId, attendanceScoring.mes],
      set: {
        totalSesiones: s.totalSesiones,
        asistencias: s.asistencias,
        porcentaje: s.porcentaje,
        rachaActual: s.rachaActual,
        rachaMaxima: s.rachaMaxima,
        nivel: s.nivel,
        updatedAt: new Date(),
      },
    });
  return s;
}

// Hitos de racha (en semanas) que dan premio. Al alcanzar uno, se avisa al admin.
const RACHA_PREMIOS = [4, 8, 12, 24, 52];

/**
 * Si el usuario alcanza EXACTAMENTE un hito de racha, notifica a los super_admin
 * para que le entreguen el premio. Deduplicado por usuario+hito+admin.
 * Best-effort: nunca lanza.
 */
export async function notifyStreakRewardToAdmins(userId: string): Promise<void> {
  try {
    const s = await computeUserScoring(userId);
    const premio = RACHA_PREMIOS.find((m) => m === s.rachaActual);
    if (!premio) return;

    const [u] = await db.select({ nombre: users.nombreCompleto }).from(users).where(eq(users.id, userId)).limit(1);
    const nombre = u?.nombre ?? 'Un miembro';
    const admins = await db.select({ id: users.id }).from(users).where(and(eq(users.rol, 'super_admin'), eq(users.activo, true)));

    for (const a of admins) {
      await notifyUser(
        a.id,
        {
          title: 'Premio de racha por entregar',
          body: `${nombre} alcanzó una racha de ${premio} semanas seguidas. ¡Hora de entregarle su premio!`,
          url: '/admin',
        },
        { tipo: 'sistema', dedupeKey: `racha-premio-${userId}-${premio}-${a.id}` },
      ).catch(() => {});
    }
  } catch {
    /* best-effort */
  }
}

// Re-exportar para uso en jobs
export { businessDaysSince };

void sql;
