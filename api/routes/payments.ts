import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../db/client';
import { payments, userPlans, planTypes, users } from '../db/schema';
import { requireAuth } from '../middleware/jwt';
import { requireStaff } from '../middleware/rbac';
import { paymentLimit } from '../middleware/rateLimit';
import { createWompiCheckoutUrl, verifyWompiSignature, type WompiEvent } from '../services/wompi.service';
import { notifyUser } from '../services/webpush.service';
import { randomToken } from '../lib/password';

export const paymentsRouter = new Hono();

// ---- Webhook Wompi (público, sin auth) ----
paymentsRouter.post('/wompi-webhook', async (c) => {
  const body = (await c.req.json()) as WompiEvent;
  if (!verifyWompiSignature(body)) return c.json({ error: 'invalid_signature' }, 401);

  const tx = body?.data?.transaction;
  if (!tx) return c.json({ error: 'no_tx' }, 400);

  const pay = await db.select().from(payments).where(eq(payments.referenciaExterna, tx.reference)).limit(1);
  const payment = pay[0];
  if (!payment) {
    console.warn('[wompi] referencia desconocida', tx.reference);
    return c.json({ ok: true, ignored: true });
  }

  let newStatus: typeof payment.estado = 'pendiente';
  if (tx.status === 'APPROVED') newStatus = 'exitoso';
  else if (tx.status === 'DECLINED' || tx.status === 'ERROR' || tx.status === 'VOIDED') newStatus = 'fallido';

  // Atomicidad: estado de pago + activación de plan en una sola transacción.
  // Si algo falla, no queda un pago 'exitoso' con el plan sin activar (ni viceversa).
  await db.transaction(async (tx) => {
    await tx
      .update(payments)
      .set({ estado: newStatus, updatedAt: new Date() })
      .where(eq(payments.id, payment.id));
    if (newStatus === 'exitoso' && payment.userPlanId) {
      await tx.update(userPlans).set({ estado: 'activo' }).where(eq(userPlans.id, payment.userPlanId));
    }
  });

  // Notificaciones fuera de la transacción (I/O de red, best-effort)
  if (newStatus === 'exitoso') {
    const planRow = payment.userPlanId
      ? await db.select({ nombre: planTypes.nombre, fechaFin: userPlans.fechaFin }).from(userPlans).innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id)).where(eq(userPlans.id, payment.userPlanId)).limit(1)
      : [];
    const nombre = planRow[0]?.nombre ?? 'tu plan';
    const fechaFin = planRow[0]?.fechaFin ?? '';
    await notifyUser(payment.userId, {
      title: '¡Pago recibido! 💪',
      body: `Tu ${nombre} está activo${fechaFin ? ` hasta ${fechaFin}` : ''}. ¡A entrenar!`,
      url: '/app/pagos',
    }, { tipo: 'pago_ok' });
  } else if (newStatus === 'fallido') {
    await notifyUser(payment.userId, {
      title: 'Problema con tu pago ⚠️',
      body: 'Hubo un problema procesando tu pago. Intenta de nuevo o contacta al club.',
      url: '/app/pagos',
    }, { tipo: 'pago_fail' });
  }
  return c.json({ ok: true });
});

// ---- Resto requieren auth ----
paymentsRouter.use('*', requireAuth);

// Mi historial
paymentsRouter.get('/me', async (c) => {
  const me = c.get('user');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20), 1), 100);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  const rows = await db
    .select({
      id: payments.id,
      monto: payments.montoCop,
      metodo: payments.metodo,
      estado: payments.estado,
      notas: payments.notas,
      createdAt: payments.createdAt,
      userPlanId: payments.userPlanId,
      referenciaExterna: payments.referenciaExterna,
    })
    .from(payments)
    .where(eq(payments.userId, me.sub))
    .orderBy(desc(payments.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json({ payments: rows, limit, offset });
});

// Crear intención de pago Wompi (devuelve checkout URL)
const intentSchema = z.object({
  userPlanId: z.string().uuid(),
  metodo: z.enum(['wompi_card', 'wompi_nequi', 'wompi_pse']).default('wompi_card'),
});

paymentsRouter.post('/wompi/intent', paymentLimit, zValidator('json', intentSchema), async (c) => {
  const me = c.get('user');
  const { userPlanId, metodo } = c.req.valid('json');
  const planRow = await db.select().from(userPlans).where(and(eq(userPlans.id, userPlanId), eq(userPlans.userId, me.sub))).limit(1);
  if (!planRow[0]) return c.json({ error: 'plan_no_encontrado' }, 404);
  const userRow = await db.select({ email: users.email }).from(users).where(eq(users.id, me.sub)).limit(1);

  const reference = `fv_${randomToken(12)}`;
  await db.insert(payments).values({
    userId: me.sub,
    userPlanId,
    montoCop: planRow[0].precioCopAplicado,
    metodo,
    estado: 'pendiente',
    referenciaExterna: reference,
  });

  const appUrl = process.env.PUBLIC_APP_URL ?? 'https://fitvang.vercel.app';
  const checkoutUrl = await createWompiCheckoutUrl({
    reference,
    amountInCents: planRow[0].precioCopAplicado * 100,
    customerEmail: userRow[0]?.email ?? 'cliente@fitvang.com',
    redirectUrl: `${appUrl}/app/pagos?resultado=ok&ref=${reference}`,
  });
  return c.json({ reference, checkoutUrl });
});

// Pago en efectivo (coach/admin)
const cashSchema = z.object({
  userId: z.string().uuid(),
  userPlanId: z.string().uuid().optional(),
  montoCop: z.number().int().positive().max(100_000_000),
  notas: z.string().trim().max(500).optional(),
});
paymentsRouter.post('/efectivo', requireStaff, zValidator('json', cashSchema), async (c) => {
  const me = c.get('user');
  const body = c.req.valid('json');

  // Registro de pago + activación de plan de forma atómica
  const payId = await db.transaction(async (tx) => {
    const [pay] = await tx
      .insert(payments)
      .values({
        userId: body.userId,
        userPlanId: body.userPlanId,
        montoCop: body.montoCop,
        metodo: 'efectivo',
        estado: 'exitoso',
        notas: body.notas,
        registradoPor: me.sub,
      })
      .returning({ id: payments.id });
    if (body.userPlanId) {
      await tx.update(userPlans).set({ estado: 'activo' }).where(eq(userPlans.id, body.userPlanId));
    }
    return pay.id;
  });

  await notifyUser(body.userId, {
    title: '¡Pago recibido en efectivo! ✅',
    body: `Tu pago de $${body.montoCop.toLocaleString('es-CO')} COP fue registrado por ${me.nombre}.`,
    url: '/app/pagos',
  }, { tipo: 'pago_efectivo' });
  return c.json({ id: payId });
});

// Lista global (admin) — paginada
paymentsRouter.get('/', requireStaff, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  const userId = c.req.query('userId');
  const rows = await db
    .select({
      id: payments.id,
      userId: payments.userId,
      nombre: users.nombreCompleto,
      monto: payments.montoCop,
      metodo: payments.metodo,
      estado: payments.estado,
      createdAt: payments.createdAt,
      notas: payments.notas,
    })
    .from(payments)
    .innerJoin(users, eq(payments.userId, users.id))
    .where(userId ? eq(payments.userId, userId) : undefined)
    .orderBy(desc(payments.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json({ payments: rows, limit, offset });
});
