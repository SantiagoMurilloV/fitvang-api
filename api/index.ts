import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './lib/env';
import { authRouter } from './routes/auth';
import { usersRouter } from './routes/users';
import { plansRouter } from './routes/plans';
import { classesRouter } from './routes/classes';
import { bookingsRouter } from './routes/bookings';
import { attendanceRouter } from './routes/attendance';
import { paymentsRouter } from './routes/payments';
import { notificationsRouter } from './routes/notifications';
import { statsRouter } from './routes/stats';
import { jobsRouter } from './routes/jobs';
import { globalLimit } from './middleware/rateLimit';
import { db } from './db/client';
import { sql } from 'drizzle-orm';

export const app = new Hono().basePath('/api');

// ── Seguridad: headers HTTP ────────────────────────────────────────────────
// Equivalente a Helmet en Express. Hono tiene secureHeaders built-in.
app.use('*', secureHeaders({
  xFrameOptions: 'DENY',
  xContentTypeOptions: 'nosniff',
  referrerPolicy: 'strict-origin-when-cross-origin',
  xXssProtection: '1; mode=block',
  strictTransportSecurity: env.IS_PROD ? 'max-age=31536000; includeSubDomains' : false,
}));

// ── Logger ─────────────────────────────────────────────────────────────────
app.use('*', logger());

// ── CORS whitelist ─────────────────────────────────────────────────────────
app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!origin) return null;
      if (origin === env.PUBLIC_APP_URL) return origin;
      if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
      // Vercel preview URLs
      if (/^https:\/\/fitvang.*\.vercel\.app$/.test(origin)) return origin;
      return null;
    },
    credentials: true,
  }),
);

// ── Rate limiting global: 300 req/min por IP (igual que Bullfit) ───────────
app.use('*', globalLimit);

// ── Health check real: verifica conexión a PostgreSQL ─────────────────────
app.get('/health', async (c) => {
  try {
    await db.execute(sql`SELECT 1`);
    return c.json({ status: 'ok', service: 'fitvang-api', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    console.error('[health] DB check failed:', err);
    // Alerta al webhook de Discord/Telegram si está configurado
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '🚨 **Fitvang API** — Base de datos no disponible. Health check fallido.' }),
      }).catch(() => {});
    }
    return c.json({ status: 'degraded', service: 'fitvang-api', db: 'error', time: new Date().toISOString() }, 503);
  }
});

app.route('/auth', authRouter);
app.route('/users', usersRouter);
app.route('/plans', plansRouter);
app.route('/classes', classesRouter);
app.route('/bookings', bookingsRouter);
app.route('/attendance', attendanceRouter);
app.route('/payments', paymentsRouter);
app.route('/notifications', notificationsRouter);
app.route('/stats', statsRouter);
app.route('/jobs', jobsRouter);

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404));
app.onError((err, c) => {
  console.error('[api error]', err);
  // Alerta Discord en errores 500 en producción
  if (env.IS_PROD) {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: `🚨 **Fitvang API Error 500**\n\`${err.message}\`\nRuta: \`${c.req.path}\``,
        }),
      }).catch(() => {});
    }
  }
  return c.json({ error: 'internal_error', message: env.IS_PROD ? 'Error interno del servidor' : err.message }, 500);
});

export type AppType = typeof app;
