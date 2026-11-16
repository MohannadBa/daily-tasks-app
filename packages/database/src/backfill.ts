/**
 * Post-migration data step: builds the time ledger for tasks created before the enterprise
 * workflow existed and ensures default departments/categories. Idempotent.
 *   node packages/database/dist/backfill.js     (run by the container "migrate" mode)
 */
import { PrismaClient } from '@prisma/client';
import { backfillAllLedgers, verifyLedgers } from './ledger-backfill';

async function main() {
  const prisma = new PrismaClient();
  try {
    await backfillAllLedgers(prisma, (m) => console.info(m));
    const problems = await verifyLedgers(prisma);
    if (problems.length) {
      console.error(`ledger verification failed:\n - ${problems.join('\n - ')}`);
      process.exitCode = 1;
    } else {
      console.info('ledger verification: ok');
    }
  } finally {
    await prisma.$disconnect();
  }
}

void main();
