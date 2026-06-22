import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, queryClient } from './client';

async function main() {
  console.log('→ Running migrations…');
  await migrate(db, { migrationsFolder: './api/db/migrations' });
  console.log('✓ Migrations applied');
  await queryClient.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('✗ Migration failed:', err);
  process.exit(1);
});
