import { execSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@dailytasks/database';

/** Recreates the test schema. Refuses to run against a database not named *_test. */
export default async function setup() {
  await import('./env');
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.pathname.endsWith('_test')) throw new Error('Refusing to reset a non-test database');
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();
  const schema = path.resolve(__dirname, '../../../packages/database/prisma/schema.prisma');
  execSync(`npx prisma migrate deploy --schema "${schema}"`, { stdio: 'ignore', env: process.env });
}
