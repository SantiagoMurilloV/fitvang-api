import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { ACCESS_COOKIE } from '../lib/env';
import { verifyAccess, type AccessPayload } from '../lib/jwt';

declare module 'hono' {
  interface ContextVariableMap {
    user: AccessPayload;
  }
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, ACCESS_COOKIE);
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  const payload = await verifyAccess(token);
  if (!payload) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', payload);
  await next();
};

export const optionalAuth: MiddlewareHandler = async (c, next) => {
  const token = getCookie(c, ACCESS_COOKIE);
  if (token) {
    const payload = await verifyAccess(token);
    if (payload) c.set('user', payload);
  }
  await next();
};
