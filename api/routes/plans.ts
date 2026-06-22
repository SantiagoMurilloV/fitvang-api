import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { addDays, format } from 'date-fns';
import { db } from '../db/client';
import { planTypes, planGroups, userPlans, trainingTypes } from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { requireAdmin } from '../middleware/rbac';

export const plansRouter = new Hono();
plansRouter.use('*', requireAuth);

// LIST plan types (catálogo público)
plansRouter.get('/types', async (c) => {
  const rows = await db
    .select({
      id: planTypes.id,
      nombre: planTypes.nombre,
      modalidad: planTypes.modalidad,
      precioBaseCop: planTypes.precioBaseCop,
      minPersonas: planTypes.minPersonas,
      maxPersonas: planTypes.maxPersonas,
      duracionDias: planTypes.duracionDias,
      activo: planTypes.activo,
      descripcion: planTypes.descripcion,
      trainingTypeId: planTypes.trainingTypeId,
      trainingSlug: trainingTypes.slug,
      trainingNombre: trainingTypes.nombre,
      trainingColor: trainingTypes.colorHex,
      accesoMulti: trainingTypes.accesoMulti,
    })
    .from(planTypes)
    .innerJoin(trainingTypes, eq(planTypes.trainingTypeId, trainingTypes.id))
    .orderBy(planTypes.precioBaseCop);
  return c.json({ planTypes: rows });
});

// CREATE plan type
const planTypeSchema = z.object({
  nombre: z.string().trim().min(2).max(100),
  trainingTypeId: z.string().uuid(),
  modalidad: z.enum(['individual', 'pareja', 'amigos']),
  precioBaseCop: z.number().int().positive().max(100_000_000),
  minPersonas: z.number().int().min(1).default(1),
  maxPersonas: z.number().int().max(100).nullable().optional(),
  duracionDias: z.number().int().positive().max(365).default(30),
  descripcion: z.string().trim().max(500).optional(),
  activo: z.boolean().default(true),
});
plansRouter.post('/types', requireAdmin, zValidator('json', planTypeSchema), async (c) => {
  const body = c.req.valid('json');
  const [row] = await db.insert(planTypes).values(body).returning({ id: planTypes.id });
  return c.json({ id: row.id });
});

plansRouter.patch('/types/:id', requireAdmin, zValidator('json', planTypeSchema.partial()), async (c) => {
  await db.update(planTypes).set(c.req.valid('json')).where(eq(planTypes.id, c.req.param('id')));
  return c.json({ ok: true });
});

// Asignar plan a usuario
const assignSchema = z.object({
  userId: z.string().uuid(),
  planTypeId: z.string().uuid(),
  planGroupId: z.string().uuid().optional(),
  precioCopAplicado: z.number().int().positive().max(100_000_000).optional(),
  notasAdmin: z.string().trim().max(500).optional(),
});
plansRouter.post('/assign', requireAdmin, zValidator('json', assignSchema), async (c) => {
  const me = c.get('user');
  const body = c.req.valid('json');
  const pt = await db.select().from(planTypes).where(eq(planTypes.id, body.planTypeId)).limit(1);
  if (!pt[0]) return c.json({ error: 'plan_no_encontrado' }, 404);
  const today = new Date();
  const fechaInicio = format(today, 'yyyy-MM-dd');
  const fechaFin = format(addDays(today, pt[0].duracionDias), 'yyyy-MM-dd');
  const precio = body.precioCopAplicado ?? pt[0].precioBaseCop;

  // Pausar/expirar planes activos anteriores del mismo training
  await db
    .update(userPlans)
    .set({ estado: 'cancelado' })
    .where(and(eq(userPlans.userId, body.userId), eq(userPlans.estado, 'activo')));

  const [row] = await db
    .insert(userPlans)
    .values({
      userId: body.userId,
      planTypeId: body.planTypeId,
      planGroupId: body.planGroupId,
      precioCopAplicado: precio,
      fechaInicio,
      fechaFin,
      estado: 'activo',
      creadoPor: me.sub,
      notasAdmin: body.notasAdmin,
    })
    .returning({ id: userPlans.id });
  return c.json({ userPlanId: row.id, fechaFin });
});

// Mi plan activo
plansRouter.get('/me', async (c) => {
  const me = c.get('user');
  const rows = await db
    .select({
      id: userPlans.id,
      planTypeId: userPlans.planTypeId,
      planNombre: planTypes.nombre,
      modalidad: planTypes.modalidad,
      trainingSlug: trainingTypes.slug,
      trainingNombre: trainingTypes.nombre,
      accesoMulti: trainingTypes.accesoMulti,
      precioCopAplicado: userPlans.precioCopAplicado,
      fechaInicio: userPlans.fechaInicio,
      fechaFin: userPlans.fechaFin,
      sesionesTotales: userPlans.sesionesTotales,
      sesionesUsadas: userPlans.sesionesUsadas,
      estado: userPlans.estado,
    })
    .from(userPlans)
    .innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
    .innerJoin(trainingTypes, eq(planTypes.trainingTypeId, trainingTypes.id))
    .where(and(eq(userPlans.userId, me.sub), eq(userPlans.estado, 'activo')))
    .orderBy(desc(userPlans.fechaInicio))
    .limit(1);
  return c.json({ plan: rows[0] ?? null });
});

// Grupos
const groupSchema = z.object({
  planTypeId: z.string().uuid(),
  nombreGrupo: z.string().trim().max(100).optional(),
  descuentoEspecialCop: z.number().int().min(0).max(100_000_000).default(0),
});
plansRouter.post('/groups', requireAdmin, zValidator('json', groupSchema), async (c) => {
  const me = c.get('user');
  const [row] = await db
    .insert(planGroups)
    .values({ ...c.req.valid('json'), creadoPor: me.sub })
    .returning({ id: planGroups.id });
  return c.json({ id: row.id });
});

plansRouter.get('/groups', requireAdmin, async (c) => {
  const rows = await db.select().from(planGroups).orderBy(desc(planGroups.createdAt));
  return c.json({ groups: rows });
});
