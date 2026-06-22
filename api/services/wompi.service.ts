import { createHash } from 'node:crypto';
import { env } from '../lib/env';

const BASE = env.WOMPI_SANDBOX ? 'https://sandbox.wompi.co/v1' : 'https://production.wompi.co/v1';

export interface WompiTransactionInput {
  reference: string;
  amountInCents: number;
  currency?: 'COP';
  customerEmail: string;
  redirectUrl?: string;
}

/**
 * Crea una intención de pago contra Wompi. Devuelve el checkout URL (widget hosted)
 * o lanza error si falla.
 *
 * Para el flujo embebido se usa el widget JS con WOMPI_PUBLIC_KEY; este endpoint
 * sirve para flujos servidor-a-servidor o checkout hosted.
 */
export async function createWompiCheckoutUrl(input: WompiTransactionInput): Promise<string> {
  const params = new URLSearchParams({
    'public-key': env.WOMPI_PUBLIC_KEY,
    currency: input.currency ?? 'COP',
    'amount-in-cents': String(input.amountInCents),
    reference: input.reference,
    'customer-data:email': input.customerEmail,
    'redirect-url': input.redirectUrl ?? `${env.PUBLIC_APP_URL}/app/pagos`,
  });
  // Wompi también provee endpoint hosted en su sitio:
  return `https://checkout.wompi.co/p/?${params.toString()}`;
}

/**
 * Valida la firma del webhook de Wompi.
 * Wompi envía un campo `signature.checksum` calculado como:
 *    sha256( concat(properties...) + timestamp + WOMPI_EVENT_SECRET )
 * Las `properties` son strings de paths a leer dentro de `data`.
 */
export function verifyWompiSignature(body: unknown): boolean {
  if (!env.WOMPI_EVENT_SECRET) return false;
  if (typeof body !== 'object' || body === null) return false;

  const b = body as Record<string, unknown>;
  const sig = b.signature as Record<string, unknown> | undefined;
  const checksum = sig?.checksum;
  const properties = sig?.properties;
  const timestamp = b.timestamp;

  if (typeof checksum !== 'string' || !Array.isArray(properties) || typeof timestamp !== 'number') return false;

  const concat = (properties as string[])
    .map((p) => {
      // path estilo "transaction.id"
      return p.split('.').reduce<unknown>((acc, k) => {
        if (typeof acc === 'object' && acc !== null) {
          return (acc as Record<string, unknown>)[k];
        }
        return undefined;
      }, b.data);
    })
    .join('');
  const computed = createHash('sha256')
    .update(concat + String(timestamp) + env.WOMPI_EVENT_SECRET)
    .digest('hex');
  return computed === checksum;
}

export interface WompiEvent {
  event: string; // "transaction.updated"
  data: {
    transaction: {
      id: string;
      reference: string;
      status: 'APPROVED' | 'DECLINED' | 'VOIDED' | 'ERROR' | 'PENDING';
      amount_in_cents: number;
      currency: string;
      payment_method_type?: string;
    };
  };
  timestamp: number;
}
