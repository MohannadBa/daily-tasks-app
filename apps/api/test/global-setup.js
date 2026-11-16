const { execSync } = require('node:child_process');
const path = require('node:path');

/**
 * Recreates the *test* database schema and applies all migrations.
 * Refuses to touch any database whose name does not end in "_test".
 */
module.exports = async () => {
  require('./env.js');
  const url = new URL(process.env.DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to reset non-test database "${dbName}"`);

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe('DROP SCHEMA IF EXISTS public CASCADE');
  await prisma.$executeRawUnsafe('CREATE SCHEMA public');
  await prisma.$disconnect();

  const schema = path.resolve(__dirname, '../../../packages/database/prisma/schema.prisma');
  execSync(`npx prisma migrate deploy --schema "${schema}"`, { stdio: 'inherit', env: process.env });
};
