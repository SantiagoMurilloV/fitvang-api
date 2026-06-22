// Rate limiting en memoria con sliding window.
// En Vercel Serverless cada instancia tiene su propio store — no es global
// entre instancias, pero sí protege contra ráfagas desde una misma IP
// en la misma invocación. Para un gym pequeño (< 500 usuarios) es suficiente.
// Si se necesita rate limit global, agregar Upstash Redis como store.
//
// Patrón idéntico a Bullfit: límite global 300 req/min, login 10 req/min por IP.

import type { MiddlewareHandler } from 'hono';

interface Window {
  count: number;
  resetAt: number;
}

const stores = new Map<string, Map<string, Window>>();

function getStore(namespace: string): Map<string, Window> {
  if (!stores.has(namespace)) stores.set(namespace, new Map());
  return stores.get(namespace)!;
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'unknown'
  );
}

interface RateLimitOpts {
  /** Número máximo de requests en la ventana */
  limit: number;
  /** Duración de la ventana en ms */
  windowMs: number;
  /** Namespace para separar límites por ruta */
  namespace?: string;
  /** Mensaje de error (default: 'Demasiadas solicitudes, intenta más tarde') */
  message?: string;
}

export function rateLimit(opts: RateLimitOpts): MiddlewareHandler {
  const { limit, windowMs, namespace = 'global', message = 'Demasiadas solicitudes, intenta más tarde.' } = opts;
  const store = getStore(namespace);

  return async (c, next) => {
    const ip = getClientIp(c.req.raw);
    const key = ip;
    const now = Date.now();

    let w = store.get(key);
    if (!w || now > w.resetAt) {
      w = { count: 0, resetAt: now + windowMs };
      store.set(key, w);
    }
    w.count++;

    c.res.headers.set('X-RateLimit-Limit', String(limit));
    c.res.headers.set('X-RateLimit-Remaining', String(Math.max(0, limit - w.count)));
    c.res.headers.set('X-RateLimit-Reset', String(Math.ceil(w.resetAt / 1000)));

    if (w.count > limit) {
      const retryAfter = Math.ceil((w.resetAt - now) / 1000);
      c.res.headers.set('Retry-After', String(retryAfter));
      return c.json({ error: 'rate_limited', message }, 429);
    }

    return next();
  };
}

// Límites preconfigurados al estilo Bullfit
export const globalLimit = rateLimit({ limit: 300, windowMs: 60_000, namespace: 'global' });
export const loginLimit  = rateLimit({ limit: 10,  windowMs: 60_000, namespace: 'login',
  message: 'Demasiados intentos de inicio de sesión. Espera 1 minuto e intenta de nuevo.' });
export const paymentLimit = rateLimit({ limit: 20, windowMs: 60_000, namespace: 'payment',
  message: 'Demasiadas solicitudes de pago. Espera 1 minuto.' });
