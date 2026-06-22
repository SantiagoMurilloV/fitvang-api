// Festivos colombianos — Ley 51/1983 (fijos) + Ley Emiliani (movibles al lunes)
// + festivos dependientes de Pascua (sin Emiliani).
// Portado directamente de Bullfit Back src/utils/colombianHolidays.js
// API: isColombianHoliday, isBusinessDay, businessDaysSince, countBusinessDays, addBusinessDays

import { toZonedTime } from 'date-fns-tz';
import {
  format,
  addDays,
  differenceInCalendarDays,
  getISODay,
} from 'date-fns';

const TZ = 'America/Bogota';

// ─── Algoritmo de Pascua gregoriana (Meeus/Jones/Butcher) ────────────────────
function easterDate(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31); // 1-based
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  // Construir en TZ Bogotá para evitar desfase UTC
  return toZonedTime(new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00Z`), TZ);
}

// Mover al siguiente lunes si no es ya lunes (Ley Emiliani)
function nextMonday(date: Date): Date {
  const dow = getISODay(date); // 1=lun … 7=dom
  if (dow === 1) return date;
  return addDays(date, 8 - dow);
}

function ymd(date: Date): string {
  return format(toZonedTime(date, TZ), 'yyyy-MM-dd');
}

function mmdd(year: number, month: number, day: number): Date {
  return toZonedTime(
    new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T12:00:00Z`),
    TZ,
  );
}

// ─── Construcción del set de festivos por año ────────────────────────────────
const _cache: Record<number, Set<string>> = {};

function buildYear(year: number): Set<string> {
  const h = new Set<string>();

  // Fijos
  h.add(`${year}-01-01`); // Año Nuevo
  h.add(`${year}-05-01`); // Día del Trabajo
  h.add(`${year}-07-20`); // Independencia
  h.add(`${year}-08-07`); // Batalla de Boyacá
  h.add(`${year}-12-08`); // Inmaculada Concepción
  h.add(`${year}-12-25`); // Navidad

  // Emiliani (movibles al siguiente lunes)
  h.add(ymd(nextMonday(mmdd(year, 1, 6))));   // Reyes Magos
  h.add(ymd(nextMonday(mmdd(year, 3, 19))));  // San José
  h.add(ymd(nextMonday(mmdd(year, 6, 29))));  // San Pedro y San Pablo
  h.add(ymd(nextMonday(mmdd(year, 10, 12)))); // Día de la Raza
  h.add(ymd(nextMonday(mmdd(year, 11, 1))));  // Todos los Santos
  h.add(ymd(nextMonday(mmdd(year, 11, 11)))); // Independencia de Cartagena

  // Dependientes de Pascua (sin Emiliani — fecha exacta)
  const easter = easterDate(year);
  h.add(ymd(addDays(easter, -3)));  // Jueves Santo
  h.add(ymd(addDays(easter, -2)));  // Viernes Santo
  h.add(ymd(nextMonday(addDays(easter, 39)))); // Ascensión del Señor (Emiliani)
  h.add(ymd(nextMonday(addDays(easter, 60)))); // Corpus Christi (Emiliani)
  h.add(ymd(nextMonday(addDays(easter, 68)))); // Sagrado Corazón (Emiliani)

  return h;
}

function getYear(year: number): Set<string> {
  if (!_cache[year]) _cache[year] = buildYear(year);
  return _cache[year];
}

// ─── API pública ──────────────────────────────────────────────────────────────

export function isColombianHoliday(dateStr: string): boolean {
  return getYear(Number(dateStr.slice(0, 4))).has(dateStr);
}

export function isBusinessDay(dateStr: string): boolean {
  const date = toZonedTime(new Date(dateStr + 'T12:00:00Z'), TZ);
  const dow = getISODay(date); // 1=lun … 7=dom
  if (dow === 6 || dow === 7) return false;
  return !isColombianHoliday(dateStr);
}

export function countBusinessDays(startStr: string, endStr: string): number {
  const start = toZonedTime(new Date(startStr + 'T12:00:00Z'), TZ);
  const end = toZonedTime(new Date(endStr + 'T12:00:00Z'), TZ);
  const days = differenceInCalendarDays(end, start);
  let count = 0;
  for (let i = 0; i <= days; i++) {
    const d = format(addDays(start, i), 'yyyy-MM-dd');
    if (isBusinessDay(d)) count++;
  }
  return count;
}

export function addBusinessDays(dateStr: string, n: number): string {
  let current = toZonedTime(new Date(dateStr + 'T12:00:00Z'), TZ);
  const step = n >= 0 ? 1 : -1;
  let remaining = Math.abs(n);
  while (remaining > 0) {
    current = addDays(current, step);
    if (isBusinessDay(format(current, 'yyyy-MM-dd'))) remaining--;
  }
  return format(current, 'yyyy-MM-dd');
}

export function businessDaysSince(dateStr: string): number {
  const today = format(toZonedTime(new Date(), TZ), 'yyyy-MM-dd');
  if (dateStr >= today) return 0;
  return countBusinessDays(dateStr, today) - 1; // excluye el día inicial
}
