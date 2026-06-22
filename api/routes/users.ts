import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, desc, ilike, or } from 'drizzle-orm';
import { db } from '../db/client';
import { users, guardians, coaches } from '../db/schema';
import { hashPassword, randomToken } from '../lib/password';
import { requireAuth } from '../middleware/jwt';
import { requireAdmin, requireStaff, checkSelf } from '../middleware/rbac';
import { notifyUser } from '../services/webpush.service';

export const usersRouter = new Hono();
usersRouter.use('*', requireAuth);

const createUserSchema = z.object({
  nombreCompleto: z.string().trim().min(2).max(120),
  documento: z.string().trim().min(3).max(30),
  email: z.string().trim().email().max(150),
  telefono: z.string().trim().max(20).optional(),
  fechaNacimiento: z.string().optional(),
  genero: z.enum(['masculino', 'femenino', 'otro', 'prefiero_no_decir']).optional(),
  rol: z.enum(['super_admin', 'coach', 'user']).default('user'),
  esMenor: z.boolean().default(false),
  acudienteId: z.string().uuid().optional(),
  relacionAcudiente: z.enum(['padre', 'madre', 'tutor', 'otro']).optional(),
  password: z.string().min(6).max(128).optional(),
  avatarUrl: z.string().url().max(500).optional(),
});

// LIST (coaches can read users, admins can read all roles)
usersRouter.get('/', requireStaff, async (c) => {
  const q = c.req.query('q')?.toLowerCase();
  const rol = c.req.query('rol') as 'super_admin' | 'coach' | 'user' | undefined;
  let rows = await db
    .select({
      id: users.id,
      nombre: users.nombreCompleto,
      email: users.email,
      documento: users.documento,
      telefono: users.telefono,
      rol: users.rol,
      esMenor: users.esMenor,
      activo: users.activo,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(
      q
        ? or(ilike(users.nombreCompleto, `%${q}%`), ilike(users.email, `%${q}%`), ilike(users.documento, `%${q}%`))
        : undefined,
    )
    .orderBy(desc(users.createdAt))
    .limit(200);
  if (rol) rows = rows.filter((r) => r.rol === rol);
  return c.json({ users: rows });
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
      email: body.email.toLowerCase(),
      telefono: body.telefono,
      passwordHash,
      rol: body.rol,
      esMenor: body.esMenor,
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
    user: { id: u.id, email: body.email },
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
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  const { passwordHash, ...safe } = rows[0];
  return c.json({ user: safe });
});

// UPDATE
const updateSchema = createUserSchema.partial().extend({ activo: z.boolean().optional() });
usersRouter.patch('/:id', requireAdmin, zValidator('json', updateSchema), async (c) => {
  const id = c.req.param('id');
  const body = c.req.valid('json');
  const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };
  if (body.password) {
    patch.passwordHash = await hashPassword(body.password);
    delete patch.password;
  }
  delete patch.acudienteId;
  delete patch.relacionAcudiente;
  await db.update(users).set(patch).where(eq(users.id, id));
  return c.json({ ok: true });
});

// DEACTIVATE (soft)
usersRouter.delete('/:id', requireAdmin, async (c) => {
  await db.update(users).set({ activo: false }).where(eq(users.id, c.req.param('id')));
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
      avatarUrl: users.avatarUrl,
      fechaNacimiento: users.fechaNacimiento,
      genero: users.genero,
      esMenor: users.esMenor,
      pesoKg: users.pesoKg,
      alturaCm: users.alturaCm,
      bio: users.bio,
      activo: users.activo,
      createdAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  return c.json({ user: rows[0] });
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
