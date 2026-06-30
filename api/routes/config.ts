import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { clubConfig, type RolePermissions } from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { requireAdmin } from '../middleware/rbac';

export const configRouter = new Hono();
configRouter.use('*', requireAuth);

// Valida la estructura exacta de RolePermissions en runtime (antes solo se
// casteaba el JSON, permitiendo escribir estructura arbitraria en el JSONB).
const roleSchema = z.object({
  secciones: z.record(z.boolean()),
  acciones: z.record(z.boolean()),
  notificaciones: z.record(z.boolean()),
  limites: z.record(z.number().int().nullable()),
});
const permisosSchema = z.object({
  user: roleSchema,
  coach: roleSchema,
  menor: roleSchema,
  acudiente: roleSchema,
});

const DEFAULT_PERMISOS: RolePermissions = {
  user: {
    secciones: {
      dashboard: true,
      reservas: true,
      recorrido: true,
      perfil: true,
    },
    acciones: {
      reservar: true,
      cancelarReserva: true,
      subirFoto: true,
    },
    notificaciones: {
      recordatorioClase: true,
      cambioHorario: true,
      vencimientoPlan: true,
      bienvenida: true,
    },
    limites: {
      reservasPorSemana: null,
      reservasSimultaneas: 2,
    },
  },
  coach: {
    secciones: {
      dashboard: true,
      clases: true,
      usuarios: true,
      perfil: true,
    },
    acciones: {
      tomarAsistencia: true,
      verFichaUsuario: true,
      cobrarEfectivo: true,
      subirFoto: true,
    },
    notificaciones: {
      nuevaReserva: true,
      cancelacionReserva: true,
      claseProxima: true,
    },
    limites: {},
  },
  menor: {
    secciones: {
      dashboard: true,
      reservas: true,
      recorrido: true,
      perfil: true,
    },
    acciones: {
      reservar: true,
      cancelarReserva: false,
      subirFoto: true,
    },
    notificaciones: {
      recordatorioClase: true,
      cambioHorario: true,
      vencimientoPlan: true,
    },
    limites: {
      reservasPorSemana: 5,
      reservasSimultaneas: 1,
    },
  },
  acudiente: {
    secciones: {
      dashboard: true,
      reservas: false,
      recorrido: false,
      perfil: true,
      infoMenor: true,
      horariosMenor: true,
      asistenciasMenor: true,
    },
    acciones: {
      reservar: false,
      cancelarReserva: false,
      subirFoto: true,
    },
    notificaciones: {
      cambioHorario: true,
      vencimientoPlan: true,
      bienvenida: true,
      asistenciaMenor: true,
      ausenciaMenor: true,
    },
    limites: {},
  },
};

configRouter.get('/permisos', requireAdmin, async (c) => {
  const rows = await db.select({ permisos: clubConfig.permisos }).from(clubConfig).where(eq(clubConfig.id, 1)).limit(1);
  const permisos = (rows[0]?.permisos as RolePermissions | null) ?? DEFAULT_PERMISOS;
  return c.json({ permisos });
});

configRouter.patch('/permisos', requireAdmin, zValidator('json', permisosSchema), async (c) => {
  const body = c.req.valid('json') as RolePermissions;
  await db
    .insert(clubConfig)
    .values({ id: 1, permisos: body })
    .onConflictDoUpdate({ target: clubConfig.id, set: { permisos: body, updatedAt: new Date() } });
  return c.json({ ok: true });
});
