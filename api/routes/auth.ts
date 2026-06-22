import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import { users, refreshTokens } from '../db/schema';
import { signAccess, signRefresh, verifyRefresh } from '../lib/jwt';
import { verifyPassword, randomToken, sha256 } from '../lib/password';
import { setAuthCookies, clearAuthCookies } from '../lib/cookies';
import { REFRESH_COOKIE, REFRESH_TTL_S } from '../lib/env';
import { requireAuth } from '../middleware/jwt';
import { loginLimit } from '../middleware/rateLimit';

export const authRouter = new Hono();

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

authRouter.post('/login', loginLimit, zValidator('json', loginSchema), async (c) => {

  const { email, password } = c.req.valid('json');
  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  const user = rows[0];
  if (!user || !user.activo) return c.json({ error: 'credenciales_invalidas' }, 401);

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return c.json({ error: 'credenciales_invalidas' }, 401);

  const access = await signAccess({ sub: user.id, rol: user.rol, nombre: user.nombreCompleto });
  const refreshRaw = randomToken();
  const refresh = await signRefresh({ sub: user.id, jti: refreshRaw });
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: sha256(refreshRaw),
    expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
  });

  setAuthCookies(c, access, refresh);
  return c.json({
    user: { id: user.id, nombre: user.nombreCompleto, rol: user.rol, email: user.email },
    redirect: user.rol === 'super_admin' ? '/admin' : user.rol === 'coach' ? '/coach' : '/app',
  });
});

authRouter.post('/logout', async (c) => {
  const refreshTok = getCookie(c, REFRESH_COOKIE);
  if (refreshTok) {
    const payload = await verifyRefresh(refreshTok);
    if (payload) {
      await db
        .update(refreshTokens)
        .set({ revoked: true })
        .where(and(eq(refreshTokens.userId, payload.sub), eq(refreshTokens.tokenHash, sha256(payload.jti))));
    }
  }
  clearAuthCookies(c);
  return c.json({ ok: true });
});

authRouter.post('/refresh', async (c) => {
  const refreshTok = getCookie(c, REFRESH_COOKIE);
  if (!refreshTok) return c.json({ error: 'no_refresh' }, 401);
  const payload = await verifyRefresh(refreshTok);
  if (!payload) return c.json({ error: 'invalid_refresh' }, 401);
  const hash = sha256(payload.jti);
  const rows = await db
    .select()
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, hash), eq(refreshTokens.userId, payload.sub)))
    .limit(1);
  const row = rows[0];
  if (!row || row.revoked || row.expiresAt < new Date()) return c.json({ error: 'invalid_refresh' }, 401);

  const userRows = await db.select().from(users).where(eq(users.id, payload.sub)).limit(1);
  const user = userRows[0];
  if (!user || !user.activo) return c.json({ error: 'user_inactive' }, 401);

  // Rotate refresh
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.id, row.id));
  const newRaw = randomToken();
  const newRefresh = await signRefresh({ sub: user.id, jti: newRaw });
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: sha256(newRaw),
    expiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
  });
  const access = await signAccess({ sub: user.id, rol: user.rol, nombre: user.nombreCompleto });
  setAuthCookies(c, access, newRefresh);
  return c.json({ ok: true });
});

authRouter.get('/me', requireAuth, async (c) => {
  const u = c.get('user');
  const rows = await db
    .select({
      id: users.id,
      nombre: users.nombreCompleto,
      email: users.email,
      rol: users.rol,
      avatarUrl: users.avatarUrl,
      esMenor: users.esMenor,
    })
    .from(users)
    .where(eq(users.id, u.sub))
    .limit(1);
  if (!rows[0]) return c.json({ error: 'not_found' }, 404);
  return c.json({ user: rows[0] });
});
