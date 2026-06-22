import { sql, eq, and, gte, lte } from 'drizzle-orm';
import { format, startOfMonth, endOfMonth } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { db } from '../db/client';
import { bookings, classSessions, attendanceScoring } from '../db/schema';
import { isBusinessDay, businessDaysSince } from '../lib/colombianHolidays';

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

/**
 * Una semana es COMPLETA si tiene ≥3 días hábiles consecutivos con asistencia.
 * Igual que Bullfit: excluye festivos, solo L–V.
 */
function hasThreeConsecutive(attendedSet: Set<string>, mondayStr: string): boolean {
  const bizDays: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(mondayStr + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    const s = format(d, 'yyyy-MM-dd');
    if (isBusinessDay(s)) bizDays.push(s);
  }
  for (let i = 0; i <= bizDays.length - 3; i++) {
    if (
      attendedSet.has(bizDays[i]) &&
      attendedSet.has(bizDays[i + 1]) &&
      attendedSet.has(bizDays[i + 2])
    ) return true;
  }
  return false;
}

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

  // Semana actual cuenta si ya completó 3 consecutivos
  const todaySet = weekMap.get(checkWk);
  if (todaySet && hasThreeConsecutive(todaySet, mondayOfWeek(checkWk))) {
    rachaActual++;
  }

  checkWk = prevWeekKey(checkWk);
  while (true) {
    const s = weekMap.get(checkWk);
    if (!s || !hasThreeConsecutive(s, mondayOfWeek(checkWk))) break;
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
    const complete = hasThreeConsecutive(s, mondayOfWeek(wk));
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

  // Para la racha necesitamos TODOS los días históricos asistidos, no solo del mes
  const allAttended = await db
    .select({ fecha: classSessions.fecha })
    .from(bookings)
    .innerJoin(classSessions, eq(bookings.sessionId, classSessions.id))
    .where(and(eq(bookings.userId, userId), eq(bookings.estado, 'asistio')));

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

// Re-exportar para uso en jobs
export { businessDaysSince };

void sql;
