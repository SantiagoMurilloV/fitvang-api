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

// Lista global (admin/coach) — paginada. Filtros: ?userId= y ?estado=
// Incluye foto, nombre y, si el pago va ligado a un plan, las fechas de la suscripción.
paymentsRouter.get('/', requireStaff, async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100), 1), 500);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);
  const userId = c.req.query('userId');
  const estado = c.req.query('estado') as 'pendiente' | 'exitoso' | 'fallido' | 'reembolsado' | undefined;

  const conds = [];
  if (userId) conds.push(eq(payments.userId, userId));
  if (estado) conds.push(eq(payments.estado, estado));

  const rows = await db
    .select({
      id: payments.id,
      userId: payments.userId,
      nombre: users.nombreCompleto,
      avatarUrl: users.avatarUrl,
      monto: payments.montoCop,
      metodo: payments.metodo,
      estado: payments.estado,
      createdAt: payments.createdAt,
      notas: payments.notas,
      planNombre: planTypes.nombre,
      fechaInicio: userPlans.fechaInicio,
      fechaFin: userPlans.fechaFin,
    })
    .from(payments)
    .innerJoin(users, eq(payments.userId, users.id))
    .leftJoin(userPlans, eq(payments.userPlanId, userPlans.id))
    .leftJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(payments.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json({ payments: rows, limit, offset });
});

// Cambiar el estado de un pago (solo staff): marcar pagado o devolver a pendiente
// (por si se marcó por error). metodo solo aplica al marcar pagado.
const updatePaymentSchema = z.object({
  estado: z.enum(['pendiente', 'exitoso']),
  metodo: z.enum(['efectivo', 'transferencia', 'wompi_card', 'wompi_nequi', 'wompi_pse']).optional(),
});
paymentsRouter.patch('/:id', requireStaff, zValidator('json', updatePaymentSchema), async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const rows = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
  const p = rows[0];
  if (!p) return c.json({ error: 'not_found' }, 404);
  if (p.estado === body.estado) return c.json({ ok: true }); // sin cambios

  if (body.estado === 'exitoso') {
    await db.transaction(async (tx) => {
      await tx
        .update(payments)
        .set({ estado: 'exitoso', metodo: body.metodo ?? p.metodo, registradoPor: me.sub, updatedAt: new Date() })
        .where(eq(payments.id, id));
      if (p.userPlanId) {
        await tx.update(userPlans).set({ estado: 'activo' }).where(eq(userPlans.id, p.userPlanId));
      }
    });

    // Nombre del plan (si el pago va ligado a uno) para la notificación de agradecimiento
    let planNombre = '';
    if (p.userPlanId) {
      const [pl] = await db
        .select({ nombre: planTypes.nombre })
        .from(userPlans)
        .innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
        .where(eq(userPlans.id, p.userPlanId))
        .limit(1);
      planNombre = pl?.nombre ?? '';
    }
    const monto = `$${p.montoCop.toLocaleString('es-CO')} COP`;
    await notifyUser(p.userId, {
      title: '¡Gracias por tu pago!',
      body: planNombre
        ? `Tu pago de ${monto} por el plan ${planNombre} quedó registrado. ¡Nos vemos en el entreno!`
        : `Tu pago de ${monto} quedó registrado. ¡Gracias!`,
      url: '/app/pagos',
    }, { tipo: 'pago_ok' });
  } else {
    // Revertir a pendiente (corrección de un error)
    await db
      .update(payments)
      .set({ estado: 'pendiente', updatedAt: new Date() })
      .where(eq(payments.id, id));
  }

  return c.json({ ok: true });
});
