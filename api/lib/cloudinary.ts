import { createHash } from 'crypto';
import { env } from './env';
import { fetchWithTimeout } from './http';

/**
 * Sube un documento (HTML/texto) a Cloudinary como recurso `raw` (firmado).
 * Devuelve la secure_url. Lanza si falla.
 */
export async function uploadRawDoc(publicId: string, content: string, contentType = 'text/html'): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  // Firma: parámetros ordenados alfabéticamente + API secret (sin &)
  const toSign = `public_id=${publicId}&timestamp=${timestamp}${env.CLOUDINARY_API_SECRET}`;
  const signature = createHash('sha1').update(toSign).digest('hex');

  const fd = new FormData();
  fd.append('file', new Blob([content], { type: contentType }), 'documento.html');
  fd.append('timestamp', timestamp);
  fd.append('api_key', env.CLOUDINARY_API_KEY);
  fd.append('signature', signature);
  fd.append('public_id', publicId);

  const res = await fetchWithTimeout(
    `https://api.cloudinary.com/v1_1/${env.CLOUDINARY_CLOUD}/raw/upload`,
    { method: 'POST', body: fd },
    15_000,
  );
  let data: any = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok || !data?.secure_url) {
    throw new Error(data?.error?.message ?? 'cloudinary_raw_failed');
  }
  return data.secure_url as string;
}
