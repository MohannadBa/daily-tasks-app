/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';

/**
 * READ-ONLY database TLS check, run as a one-off ECS task (migrate task definition, command override):
 *   node /app/packages/database/dist/db-tls-check.js
 * Positive check (normal env, DB_SSL_CA_FILE = RDS bundle): must print "encrypted=true" and exit 0.
 * Negative check (override DB_SSL_CA_FILE=/etc/ssl/certs/ca-certificates.crt, public CAs only): must
 * print "REFUSED" and exit 3 — proving the server certificate is really verified, not just encrypted.
 * Prints no credentials or host details beyond the host name.
 */
async function main() {
  const url = process.env.DATABASE_URL ?? '';
  let host = 'unknown';
  let verified = false;
  try {
    const u = new URL(url);
    host = u.hostname;
    verified = u.searchParams.get('sslaccept') === 'strict' && !!u.searchParams.get('sslcert');
  } catch {
    /* no URL */
  }
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<Array<{ ssl: boolean; version: string | null; cipher: string | null }>>`SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()`;
    const r = rows[0];
    console.log(`db-tls: host ${host}, certificate verification ${verified ? 'ON (sslaccept=strict)' : 'OFF'}`);
    console.log(`db-tls: CONNECTED encrypted=${!!r?.ssl} version=${r?.version ?? '-'} cipher=${r?.cipher ?? '-'}`);
    process.exitCode = r?.ssl && verified ? 0 : 1;
  } catch (e) {
    const msg = String((e as Error).message).split('\n').filter(Boolean).pop() ?? '';
    console.log(`db-tls: host ${host}, certificate verification ${verified ? 'ON' : 'OFF'}`);
    console.log(`db-tls: REFUSED (${msg.includes('certificate verify failed') ? 'certificate verify failed' : (e as Error).name})`);
    process.exitCode = 3;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
