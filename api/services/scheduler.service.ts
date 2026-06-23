import { addDays, format } from 'date-fns';
import { eq, and, lte } from 'drizzle-orm';
import { db } from '../db/client';
import { classTemplates, classSessions } from '../db/schema';

const WEEKDAY_MAP: Record<number, typeof classTemplates.$inferInsert.diaSemana> = {
  1: 'lunes',
  2: 'martes',
  3: 'miercoles',
  4: 'jueves',
  5: 'viernes',
  6: 'sabado',
  0: 'domingo',
};

/**
 * Asegura que existan `class_sessions` para los próximos `daysAhead` días.
 * Un solo INSERT batch en lugar de N round-trips secuenciales.
 */
export async function generateUpcomingSessions(daysAhead = 30): Promise<number> {
  const templates = await db.select().from(classTemplates).where(eq(classTemplates.activo, true));
  if (templates.length === 0) return 0;

  const today = new Date();
  const rows: { templateId: string; fecha: string; estado: 'programada' }[] = [];

  for (let i = 0; i < daysAhead; i++) {
    const date = addDays(today, i);
    const weekday = WEEKDAY_MAP[date.getDay()];
    const dateStr = format(date, 'yyyy-MM-dd');
    for (const t of templates) {
      if (t.diaSemana === weekday) {
        rows.push({ templateId: t.id, fecha: dateStr, estado: 'programada' });
      }
    }
  }

  if (rows.length === 0) return 0;

  // Batch insert — onConflictDoNothing mantiene idempotencia
  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const result = await db
      .insert(classSessions)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoNothing()
      .returning({ id: classSessions.id });
    inserted += result.length;
  }

  return inserted;
}

/**
 * Marca como `finalizada` toda sesión cuya fecha ya pasó.
 */
export async function closeFinishedSessions(): Promise<number> {
  const today = format(new Date(), 'yyyy-MM-dd');
  const updated = await db
    .update(classSessions)
    .set({ estado: 'finalizada' })
    .where(and(eq(classSessions.estado, 'programada'), lte(classSessions.fecha, today)))
    .returning({ id: classSessions.id });
  return updated.length;
}
