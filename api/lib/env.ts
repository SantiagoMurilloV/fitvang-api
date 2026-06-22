import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

export const env = {
  DATABASE_URL: required('DATABASE_URL', 'postgresql://placeholder'),
  JWT_SECRET: required('JWT_SECRET', 'dev-jwt-secret-change-me'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET', 'dev-refresh-secret-change-me'),
  WOMPI_PUBLIC_KEY: process.env.WOMPI_PUBLIC_KEY ?? '',
  WOMPI_PRIVATE_KEY: process.env.WOMPI_PRIVATE_KEY ?? '',
  WOMPI_EVENT_SECRET: process.env.WOMPI_EVENT_SECRET ?? '',
  WOMPI_SANDBOX: (process.env.WOMPI_SANDBOX ?? 'true') === 'true',
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY ?? '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY ?? '',
  VAPID_SUBJECT: process.env.VAPID_SUBJECT ?? 'mailto:hola@fitvang.com',
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  FROM_EMAIL: process.env.FROM_EMAIL ?? 'no-reply@fitvang.com',
  PUBLIC_APP_URL: process.env.PUBLIC_APP_URL ?? 'http://localhost:4321',
  APP_TIMEZONE: process.env.APP_TIMEZONE ?? 'America/Bogota',
  IS_PROD: process.env.NODE_ENV === 'production',
};

export const ACCESS_COOKIE = 'fv_access';
export const REFRESH_COOKIE = 'fv_refresh';
export const ACCESS_TTL_S = 60 * 15; // 15 min
export const REFRESH_TTL_S = 60 * 60 * 24 * 7; // 7 días
