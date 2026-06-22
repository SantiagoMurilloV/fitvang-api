import type { Context } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { ACCESS_COOKIE, REFRESH_COOKIE, ACCESS_TTL_S, REFRESH_TTL_S, env } from './env';

const baseOpts = {
  httpOnly: true,
  secure: env.IS_PROD,
  sameSite: 'Lax' as const,
  path: '/',
};

export function setAuthCookies(c: Context, accessToken: string, refreshToken: string) {
  setCookie(c, ACCESS_COOKIE, accessToken, { ...baseOpts, maxAge: ACCESS_TTL_S });
  setCookie(c, REFRESH_COOKIE, refreshToken, { ...baseOpts, maxAge: REFRESH_TTL_S });
}

export function clearAuthCookies(c: Context) {
  deleteCookie(c, ACCESS_COOKIE, { ...baseOpts });
  deleteCookie(c, REFRESH_COOKIE, { ...baseOpts });
}
