import 'dotenv/config';

const IS_PROD = process.env.NODE_ENV === 'production';

/** Obligatoria siempre, sin fallback. Si falta, la app no arranca (fail-fast). */
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

/**
 * Obligatoria solo en producción. En desarrollo usa el fallback (o '').
 * Evita arrancar prod con integraciones críticas sin configurar.
 */
function requiredInProd(name: string, devFallback = ''): string {
  const v = process.env[name];
  if (v) return v;
  if (IS_PROD) throw new Error(`Missing required env in production: ${name}`);
  return devFallback;
}

/** URL opcional validada: debe ser http(s). Devuelve '' si falta o es inválida. */
function optionalUrl(name: string): string {
  const v = process.env[name];
  if (!v) return '';
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      console.warn(`[env] ${name} ignorada: protocolo no http(s)`);
      return '';
    }
    return v;
  } catch {
    console.warn(`[env] ${name} ignorada: no es una URL válida`);
    return '';
  }
}

export const env = {
  // ── Críticas: obligatorias en TODOS los entornos, sin fallback ──
  DATABASE_URL: required('DATABASE_URL'),
  JWT_SECRET: required('JWT_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),

  // ── Obligatorias en producción (en dev pueden faltar) ──
  CRON_SECRET: requiredInProd('CRON_SECRET'),
  WOMPI_PUBLIC_KEY: requiredInProd('WOMPI_PUBLIC_KEY'),
  WOMPI_PRIVATE_KEY: requiredInProd('WOMPI_PRIVATE_KEY'),
  WOMPI_EVENT_SECRET: requiredInProd('WOMPI_EVENT_SECRET'),
  CLOUDINARY_CLOUD: requiredInProd('CLOUDINARY_CLOUD'),
  CLOUDINARY_API_KEY: requiredInProd('CLOUDINARY_API_KEY'),
  CLOUDINARY_API_SECRET: requiredInProd('CLOUDINARY_API_SECRET'),
  RESEND_API_KEY: requiredInProd('RESEND_API_KEY'),

  // ── Opcionales con default seguro ──
  WOMPI_SANDBOX: (process.env.WOMPI_SANDBOX ?? 'true') === 'true',
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? 'mailto:hola@fitvang.com',
  FROM_EMAIL: process.env.FROM_EMAIL ?? 'no-reply@fitvang.com',
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL ?? 'http://localhost:4321',
  ALERT_WEBHOOK_URL: optionalUrl('ALERT_WEBHOOK_URL'),
  APP_TIMEZONE: process.env.APP_TIMEZONE ?? 'America/Bogota',
  // ── IA (agente Vango): proveedores OpenAI-compatibles ──
  GROQ_API_KEY: process.env.GROQ_API_KEY ?? '',
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? '',
  IS_PROD,
};

export const ACCESS_COOKIE = 'fv_access';
export const REFRESH_COOKIE = 'fv_refresh';
export const ACCESS_TTL_S = 60 * 15; // 15 min
export const REFRESH_TTL_S = 60 * 60 * 24 * 7; // 7 días
