import { Hono } from 'hono';
import { createHash } from 'crypto';
import { requireAuth } from '../middleware/jwt';
import { env } from '../lib/env';

export const uploadRouter = new Hono();
uploadRouter.use('*', requireAuth);

const TRANSFORM = 'c_fill,g_face,w_200,h_200,f_webp,q_auto';

uploadRouter.post('/avatar', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];
  if (!file || typeof file === 'string') {
    return c.json({ error: 'No file provided' }, 400);
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

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/image/upload`,
    { method: 'POST', body: fd }
  );
  const data = await res.json() as any;

  if (!res.ok) {
    console.error('[cloudinary]', data?.error?.message);
    return c.json({ error: data?.error?.message ?? 'Upload failed' }, 502);
  }

  const url = (data.secure_url as string).replace('/upload/', `/upload/${TRANSFORM}/`);
  return c.json({ url });
});
