import type { Context, MiddlewareHandler } from 'hono';
import type { AccessPayload } from '../lib/jwt';

type Role = AccessPayload['rol'];

export const requireRole = (...roles: Role[]): MiddlewareHandler =>
  async (c, next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.rol)) {
      return c.json({ error: 'forbidden', required: roles }, 403);
    }
    await next();
  };

export const requireAdmin = requireRole('super_admin');
export const requireStaff = requireRole('super_admin', 'coach');

/**
 * Autorización horizontal: el usuario solo puede acceder a sus propios recursos.
 * Staff (coach, super_admin) puede acceder a cualquier recurso.
 *
 * Uso en handlers:
 *   const denied = checkSelf(c, userId);
 *   if (denied) return denied;
 */
export function checkSelf(c: Context, resourceUserId: string): Response | null {
  const me = c.get('user');
  if (!me) return c.json({ error: 'unauthenticated' }, 401) as unknown as Response;
  if (me.rol === 'user' && me.sub !== resourceUserId) {
    return c.json({ error: 'forbidden', message: 'Solo puedes acceder a tus propios datos.' }, 403) as unknown as Response;
  }
  return null;
}
