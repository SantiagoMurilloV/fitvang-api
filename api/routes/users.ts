import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, desc, ilike, or, and } from 'drizzle-orm';
import { db } from '../db/client';
import { users, guardians, coaches, userPlans, planTypes, trainingTypes } from '../db/schema';
import { hashPassword, randomToken } from '../lib/password';
import { requireAuth } from '../middleware/jwt';
import { requireAdmin, requireStaff, checkSelf } from '../middleware/rbac';
import { notifyUser } from '../services/webpush.service';
import { uploadRawDoc } from '../lib/cloudinary';
import { terminosHtml, TERMINOS_SECCIONES, TERMINOS_VERSION } from '../lib/terminos';

export const usersRouter = new Hono();
usersRouter.use('*', requireAuth);

// Términos y condiciones (para mostrar en el modal). Antes de '/:id' para que no choque.
usersRouter.get('/terminos', (c) => c.json({ version: TERMINOS_VERSION, secciones: TERMINOS_SECCIONES }));

// Aceptar T&C: genera el documento con los datos del usuario, lo guarda en Cloudinary
// y marca la aceptación. Idempotente.
usersRouter.post('/me/aceptar-terminos', async (c) => {
  const me = c.get('user');
  const [u] = await db
    .select({ nombre: users.nombreCompleto, documento: users.documento, aceptadoAt: users.terminosAceptadosAt })
    .from(users)
    .where(eq(users.id, me.sub))
    .limit(1);
  if (!u) return c.json({ error: 'not_found' }, 404);
  if (u.aceptadoAt) return c.json({ ok: true, yaAceptado: true });

  const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' });
  const html = terminosHtml({ nombre: u.nombre, documento: u.documento, fecha });

  let url = '';
  try {
    url = await uploadRawDoc(`fitvang/terminos/${me.sub}-${Date.now()}`, html);
  } catch (e) {
    console.error('[terminos] cloudinary falló, registro la aceptación igual:', e);
  }
  await db
    .update(users)
    .set({ terminosAceptadosAt: new Date(), terminosDocUrl: url || null, updatedAt: new Date() })
    .where(eq(users.id, me.sub));
  return c.json({ ok: true, url });
});

const createUserSchema = z.object({
  nombreCompleto: z.string().trim().min(2).max(120),
  documento: z.string().trim().min(3).max(30),
  email: z.string().trim().email().max(150).optional(),
  telefono: z.string().trim().max(20).optional(),
  eps: z.string().trim().max(100).optional(),
  fechaNacimiento: z.string().optional(),
  genero: z.enum(['masculino', 'femenino', 'otro', 'prefiero_no_decir']).optional(),
  rol: z.enum(['super_admin', 'coach', 'user']).default('user'),
  esMenor: z.boolean().default(false),
  esAcudiente: z.boolean().default(false),
  acudienteId: z.string().uuid().optional(),
  relacionAcudiente: z.enum(['padre', 'madre', 'tutor', 'otro']).optional(),
  password: z.string().min(6).max(128).optional(),
  avatarUrl: z.string().url().max(500).optional(),
});

// LIST (coaches can read users, admins can read all roles)
usersRouter.get('/', requireStaff, async (c) => {
  const q = c.req.query('q')?.toLowerCase();
  const rol = c.req.query('rol') as 'super_admin' | 'coach' | 'user' | undefined;
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 100);
  const offset = Math.max(Number(c.req.query('offset') ?? 0), 0);

  // Filtros aplicados en la BD (rol ya no se filtra en memoria)
  const conditions = [];
  if (q) conditions.push(or(ilike(users.nombreCompleto, `%${q}%`), ilike(users.email, `%${q}%`), ilike(users.documento, `%${q}%`)));
  if (rol) conditions.push(eq(users.rol, rol));
  const where = conditions.length ? and(...conditions) : undefined;

  const rows = await db
    .select({
      id: users.id,
      nombre: users.nombreCompleto,
      email: users.email,
      documento: users.documento,
      telefono: users.telefono,
      rol: users.rol,
      esMenor: users.esMenor,
      esAcudiente: users.esAcudiente,
      activo: users.activo,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(limit)
    .offset(offset);
  return c.json({ users: rows, limit, offset });
});

// CREATE (admin)
usersRouter.post('/', requireAdmin, zValidator('json', createUserSchema), async (c) => {
  const me = c.get('user');
  const body = c.req.valid('json');

  const generated = body.password ?? randomToken(8);
  const passwordHash = await hashPassword(generated);

  if (body.esMenor && !body.acudienteId) {
    return c.json({ error: 'menor_requiere_acudiente' }, 400);
  }

  const [u] = await db
    .insert(users)
    .values({
      nombreCompleto: body.nombreCompleto,
      documento: body.documento,
      email: body.email?.toLowerCase() ?? `${body.documento}@fitvang.local`,
      telefono: body.telefono,
      eps: body.eps,
      passwordHash,
      passwordPlain: generated, // visible para super_admin
      rol: body.rol,
      esMenor: body.esMenor,
      esAcudiente: body.esAcudiente,
      genero: body.genero,
      fechaNacimiento: body.fechaNacimiento,
      avatarUrl: body.avatarUrl,
      createdBy: me.sub,
    })
    .returning({ id: users.id });

  if (body.rol === 'coach') {
    await db.insert(coaches).values({ id: u.id }).onConflictDoNothing();
  }

  if (body.esMenor && body.acudienteId) {
    await db.insert(guardians).values({
      menorId: u.id,
      acudienteId: body.acudienteId,
      relacion: body.relacionAcudiente ?? 'otro',
      esResponsablePago: true,
    });
  }

  // Notificación de bienvenida (push si tiene subs, sino solo se guarda en BD)
  await notifyUser(u.id, {
    title: '¡Bienvenido a Fitvang! 💪',
    body: `Hola ${body.nombreCompleto.split(' ')[0]}, tu perfil está listo. Entra a la app para ver tu plan y horarios.`,
    url: '/app',
  }, { tipo: 'bienvenida' });

  return c.json({
    user: { id: u.id, email: body.email ?? null },
    passwordTemporal: body.password ? undefined : generated,
  });
});

// GET mi perfil completo
usersRouter.get('/me/profile', async (c) => {
  const me = c.get('user');
  const rows = await db
    .select({
      id: users.id,
      nombre: users.nombreCompleto,
      email: users.email,
      telefono: users.telefono,
      eps: users.eps,
      rol: users.rol,
      avatarUrl: users.avatarUrl,
      fechaNacimiento: users.fechaNacimiento,
      genero: users.genero,
      esMenor: users.esMenor,
      pesoKg: users.pesoKg,
      alturaCm: users.alturaCm,
      bio: users.bio,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, me.sub))
    .limit(1);
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  return c.json({ user: rows[0] });
});

// PATCH mi perfil (el propio usuario edita sus datos)
const selfUpdateSchema = z.object({
  nombreCompleto: z.string().trim().min(2).max(120).optional(),
  telefono: z.string().trim().max(20).optional(),
  eps: z.string().trim().max(100).optional(),
  fechaNacimiento: z.string().optional(),
  genero: z.enum(['masculino', 'femenino', 'otro', 'prefiero_no_decir']).optional(),
  pesoKg: z.number().positive().max(300).optional(),
  alturaCm: z.number().int().positive().max(250).optional(),
  bio: z.string().trim().max(300).optional(),
  avatarUrl: z.string().url().max(500).optional().or(z.literal('')),
});

usersRouter.patch('/me', zValidator('json', selfUpdateSchema), async (c) => {
  const me = c.get('user');
  const body = c.req.valid('json');
  const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };
  await db.update(users).set(patch).where(eq(users.id, me.sub));
  return c.json({ ok: true });
});

// READ
usersRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const guard = checkSelf(c, id);
  if (guard) return guard;
  // Proyección explícita: passwordHash nunca sale de la BB.DD.
  const rows = await db
    .select({
      id: users.id,
      nombreCompleto: users.nombreCompleto,
      documento: users.documento,
      email: users.email,
      telefono: users.telefono,
      eps: users.eps,
      rol: users.rol,
      avatarUrl: users.avatarUrl,
      fechaNacimiento: users.fechaNacimiento,
      genero: users.genero,
      esMenor: users.esMenor,
      esAcudiente: users.esAcudiente,
      pesoKg: users.pesoKg,
      alturaCm: users.alturaCm,
      bio: users.bio,
      activo: users.activo,
      createdAt: users.createdAt,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  return c.json({ user: rows[0] });
});

// UPDATE
const updateSchema = createUserSchema.partial().extend({ activo: z.boolean().optional() });
usersRouter.patch('/:id', requireAdmin, zValidator('json', updateSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (body.password) {
    patch.passwordHash = await hashPassword(body.password);
    patch.passwordPlain = body.password; // visible para super_admin
    delete patch.password;
  }
  delete patch.acudienteId;
  delete patch.relacionAcudiente;
  await db.update(users).set(patch).where(eq(users.id, id));
  return c.json({ ok: true });
});

// RESET PASSWORD (super_admin) — genera una nueva y la deja visible
usersRouter.post('/:id/reset-password', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const nueva = randomToken(8);
  const passwordHash = await hashPassword(nueva);
  const res = await db
    .update(users)
    .set({ passwordHash, passwordPlain: nueva, updatedAt: new Date() })
    .where(eq(users.id, id))
    .returning({ id: users.id });
  if (!res[0]) return c.json({ error: 'not_found' }, 404);
  return c.json({ password: nueva });
});

// Regenerar el documento de T&C de un usuario que ya aceptó (super_admin).
// Útil cuando la subida a Cloudinary falló en su momento.
usersRouter.post('/:id/regenerar-terminos', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const [u] = await db
    .select({ nombre: users.nombreCompleto, documento: users.documento, aceptadoAt: users.terminosAceptadosAt })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!u) return c.json({ error: 'not_found' }, 404);
  if (!u.aceptadoAt) return c.json({ error: 'no_ha_aceptado' }, 400);

  const fecha = u.aceptadoAt.toLocaleString('es-CO', { timeZone: 'America/Bogota', dateStyle: 'long', timeStyle: 'short' });
  const html = terminosHtml({ nombre: u.nombre, documento: u.documento, fecha });
  let url = '';
  try {
    url = await uploadRawDoc(`fitvang/terminos/${id}-${Date.now()}`, html);
  } catch (e) {
    console.error('[terminos] regeneración falló:', e);
    return c.json({ error: 'cloudinary_falló', detalle: String((e as Error)?.message ?? e) }, 502);
  }
  await db.update(users).set({ terminosDocUrl: url, updatedAt: new Date() }).where(eq(users.id, id));
  return c.json({ ok: true, url });
});

// DEACTIVATE (soft)
usersRouter.delete('/:id', requireAdmin, async (c) => {
  await db.update(users).set({ activo: false }).where(eq(users.id, c.req.param('id')));
  return c.json({ ok: true });
});

// HARD DELETE (super_admin only) — elimina permanentemente
usersRouter.delete('/:id/hard', requireAdmin, async (c) => {
  const me = c.get('user');
  const id = c.req.param('id');
  if (me.sub === id) return c.json({ error: 'no_puedes_eliminarte' }, 400);
  await db.delete(users).where(eq(users.id, id));
  return c.json({ ok: true });
});

// Ficha de usuario para coach/admin — incluye scoring del mes
usersRouter.get('/:id/ficha', async (c) => {
  const me = c.get('user');
  if (me.rol === 'user') return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const rows = await db
    .select({
      id: users.id,
      nombre: users.nombreCompleto,
      email: users.email,
      telefono: users.telefono,
      eps: users.eps,
      documento: users.documento,
      avatarUrl: users.avatarUrl,
      fechaNacimiento: users.fechaNacimiento,
      genero: users.genero,
      esMenor: users.esMenor,
      pesoKg: users.pesoKg,
      alturaCm: users.alturaCm,
      bio: users.bio,
      activo: users.activo,
      rol: users.rol,
      createdAt: users.createdAt,
      passwordPlain: users.passwordPlain,
      terminosAceptadosAt: users.terminosAceptadosAt,
      terminosDocUrl: users.terminosDocUrl,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);

  // Plan activo del usuario
  const planRows = await db
    .select({
      id: userPlans.id,
      planNombre: planTypes.nombre,
      trainingNombre: trainingTypes.nombre,
      trainingColor: trainingTypes.colorHex,
      modalidad: planTypes.modalidad,
      precioCopAplicado: userPlans.precioCopAplicado,
      fechaInicio: userPlans.fechaInicio,
      fechaFin: userPlans.fechaFin,
      estado: userPlans.estado,
      renovacionAutomatica: userPlans.renovacionAutomatica,
    })
    .from(userPlans)
    .innerJoin(planTypes, eq(userPlans.planTypeId, planTypes.id))
    .innerJoin(trainingTypes, eq(planTypes.trainingTypeId, trainingTypes.id))
    .where(and(eq(userPlans.userId, id), eq(userPlans.estado, 'activo')))
    .orderBy(desc(userPlans.fechaInicio));

  // La contraseña en claro solo se expone al super_admin
  const user = me.rol === 'super_admin' ? rows[0] : { ...rows[0], passwordPlain: undefined };
  // planActivo (el primero) por compatibilidad; planesActivos = todos (multi-plan)
  return c.json({ user, planActivo: planRows[0] ?? null, planesActivos: planRows });
});

// Acudientes del menor
usersRouter.get('/:id/acudientes', async (c) => {
  const id = c.req.param('id');
  const guard = checkSelf(c, id);
  if (guard) return guard;
  const rows = await db
    .select({
      id: guardians.id,
      acudienteId: guardians.acudienteId,
      relacion: guardians.relacion,
      esResponsablePago: guardians.esResponsablePago,
    })
    .from(guardians)
    .where(eq(guardians.menorId, id));
  return c.json({ acudientes: rows });
});

// Menores a cargo del acudiente
usersRouter.get('/:id/menores', async (c) => {
  const id = c.req.param('id');
  const guard = checkSelf(c, id);
  if (guard) return guard;
  const rows = await db
    .select({
      menorId: guardians.menorId,
      relacion: guardians.relacion,
      esResponsablePago: guardians.esResponsablePago,
      nombre: users.nombreCompleto,
      avatarUrl: users.avatarUrl,
    })
    .from(guardians)
    .innerJoin(users, eq(guardians.menorId, users.id))
    .where(eq(guardians.acudienteId, id));
  return c.json({ menores: rows });
});
