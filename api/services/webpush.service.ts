// Servicio de notificaciones: inbox persistente + web-push desacoplados.
// Patrón idéntico a Bullfit Back src/lib/notifyUser.js:
//   1) Persiste siempre en tabla `notifications` (campanita funciona sin permiso push)
//   2) Intenta web-push best-effort — fallo no rompe el flujo principal
//   3) Limpia automáticamente suscripciones muertas (404/410)
//   4) dedupeKey: ON CONFLICT DO NOTHING — evita doble disparo en crons
//
// Uso: notifyUser(...).catch(() => {})  — siempre fire-and-forget desde controllers

import webpush from 'web-push';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/client';
import { pushSubscriptions, notifications } from '../db/schema';
import { env } from '../lib/env';

let vapidConfigured = false;

function configureVapid() {
  if (vapidConfigured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  vapidConfigured = true;
  return true;
}

export function isVapidConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export interface NotifyPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

export type NotifType = typeof notifications.$inferInsert.tipo;

export interface NotifyOptions {
  tipo?: NotifType;
  dedupeKey?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Notifica a un usuario:
 * 1. Inserta en tabla notifications (inbox de campanita, siempre visible)
 * 2. Envía web-push a todos sus dispositivos activos (best-effort)
 *
 * Diseñado para ser llamado fire-and-forget: nunca lanza, solo loguea.
 * dedupeKey previene duplicados en crons — ON CONFLICT DO NOTHING.
 */
export async function notifyUser(
  userId: string,
  payload: NotifyPayload,
  opts: NotifyOptions = {},
): Promise<void> {
  if (!userId || !payload.title || !payload.body) return;

  const tipo = opts.tipo ?? 'sistema';

  // 1. Persistir en inbox — ON CONFLICT (dedupe_key) DO NOTHING
  let notifId: string | null = null;
  try {
    const vals = await db
      .insert(notifications)
      .values({
        userId,
        tipo,
        titulo: payload.title,
        mensaje: payload.body,
        deepLinkUrl: payload.url,
        dedupeKey: opts.dedupeKey ?? null,
        metadata: opts.metadata ?? {},
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    notifId = vals[0]?.id ?? null;
    if (!notifId) return; // ya existía (dedupeKey colisionó) — no enviar push tampoco
  } catch (err) {
    console.error('[notifyUser] inbox insert failed:', err);
    return;
  }

  // 2. Web-push best-effort
  if (!configureVapid()) return;

  try {
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.activa, true)));

    if (!subs.length) return;

    const pushPayload = JSON.stringify({ title: payload.title, body: payload.body, url: payload.url ?? '/app', tag: payload.tag });
    let anySent = false;

    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            pushPayload,
            { TTL: 60 * 60 * 24 }, // 24h — si el dispositivo está offline más tiempo, descartar
          );
          anySent = true;
        } catch (err: any) {
          const status = err?.statusCode;
          if (status === 404 || status === 410) {
            // Suscripción muerta — limpiar
            await db
              .update(pushSubscriptions)
              .set({ activa: false })
              .where(eq(pushSubscriptions.id, sub.id))
              .catch(() => {});
          } else {
            console.error('[notifyUser] push error', status, err?.body?.slice?.(0, 120));
          }
        }
      }),
    );

    if (anySent && notifId) {
      await db
        .update(notifications)
        .set({ pushSent: true })
        .where(eq(notifications.id, notifId))
        .catch(() => {});
    }
  } catch (err) {
    console.error('[notifyUser] push batch failed:', err);
  }
}

/**
 * Alias para compatibilidad con código existente que llama sendPushToUser.
 * Mapea al nuevo notifyUser.
 */
export async function sendPushToUser(
  userId: string,
  tipo: NotifType,
  payload: NotifyPayload,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  return notifyUser(userId, payload, { tipo, metadata });
}
