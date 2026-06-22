import { addDays, format } from 'date-fns';
import { eq, and, gte, lte } from 'drizzle-orm';
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
 * Asegura que existan `class_sessions` para los próximos `daysAhead` días
 * basado en las plantillas activas. Idempotente (unique en template+fecha).
 */
export async function generateUpcomingSessions(daysAhead = 30): Promise<number> {
  const templates = await db.select().from(classTemplates).where(eq(classTemplates.activo, true));
  if (templates.length === 0) return 0;
  const today = new Date();
  let inserted = 0;
  for (let i = 0; i < daysAhead; i++) {
    const date = addDays(today, i);
    const weekday = WEEKDAY_MAP[date.getDay()];
    const dateStr = format(date, 'yyyy-MM-dd');
    const matching = templates.filter((t) => t.diaSemana === weekday);
    if (matching.length === 0) continue;
    for (const t of matching) {
      try {
        await db
          .insert(classSessions)
          .values({ templateId: t.id, fecha: dateStr, estado: 'programada' })
          .onConflictDoNothing();
        inserted++;
      } catch (err) {
        console.error('[scheduler] insert error', err);
      }
    }
  }
  return inserted;
}

/**
 * Marca como `finalizada` toda sesión cuya fecha + hora_fin ya pasó.
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
