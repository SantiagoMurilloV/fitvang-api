import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

const isServerless = process.env.VERCEL === '1';

let _queryClient: ReturnType<typeof postgres> | null = null;
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

function ensure() {
  if (_queryClient && _db) return { qc: _queryClient, db: _db };
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL no está configurada. Copia .env.example a .env y pega tu connection string (Neon recomendado).',
    );
  }
  _queryClient = postgres(connectionString, {
    max: isServerless ? 1 : 10,
    prepare: false,
    idle_timeout: 20,
  });
  _db = drizzle(_queryClient, { schema });
  return { qc: _queryClient, db: _db };
}

function lazyProxy<T extends object>(get: () => T): T {
  return new Proxy({} as T, {
    get(_t, prop) {
      const target = get();
      const value = Reflect.get(target as any, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export const db = lazyProxy(() => ensure().db);
export const queryClient = lazyProxy(() => ensure().qc);

export type Db = typeof db;
export { schema };
