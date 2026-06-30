import { Hono } from 'hono';
import { createHash } from 'crypto';
import { requireAuth } from '../middleware/jwt';
import { env } from '../lib/env';
import { fetchWithTimeout } from '../lib/http';

export const uploadRouter = new Hono();
uploadRouter.use('*', requireAuth);

const TRANSFORM = 'c_fill,g_face,w_200,h_200,f_webp,q_auto';
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

uploadRouter.post('/avatar', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!file || typeof file === 'string') {
    return c.json({ error: 'No file provided' }, 400);
  }

  // Validar tipo y tamaño antes de gastar quota/tiempo de Cloudinary
  if (!ALLOWED_TYPES.includes(file.type)) {
    return c.json({ error: 'Tipo no permitido. Usa JPEG, PNG o WebP.' }, 415);
  }
  if (file.size > MAX_BYTES) {
    return c.json({ error: 'La imagen supera el límite de 5 MB.' }, 413);
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Cloudinary signed upload: parámetros ordenados alfabéticamente + API secret (sin &)
  const toSign = `timestamp=${timestamp}&transformation=${TRANSFORM}${env.CLOUDINARY_API_SECRET}`;
  const signature = createHash('sha1').update(toSign).digest('hex');

  const fd = new FormData();
  fd.append('file', file as Blob);
  fd.append('timestamp', timestamp);
  fd.append('api_key', env.CLOUDINARY_API_KEY);
  fd.append('signature', signature);
  fd.append('transformation', TRANSFORM);

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/upload`,
      { method: 'POST', body: fd },
      15_000,
    );
  } catch (err) {
    console.error('[cloudinary] timeout/red', err);
    return c.json({ error: 'No se pudo contactar el servicio de imágenes. Intenta de nuevo.' }, 504);
  }

  // Parseo defensivo: Cloudinary podría devolver HTML/no-JSON ante un error
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }

  if (!res.ok || !data?.secure_url) {
    console.error('[cloudinary]', data?.error?.message ?? res.statusText);
    return c.json({ error: data?.error?.message ?? 'Upload failed' }, 502);
  }

  const url = (data.secure_url as string).replace('/upload/', `/upload/${TRANSFORM}/`);
  return c.json({ url });
});
