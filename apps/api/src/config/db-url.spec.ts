import { ensureDatabaseUrl } from '@dailytasks/config';

describe('ensureDatabaseUrl (ECS: built from the injected RDS secret fields)', () => {
  const base = { DB_HOST: 'db.internal', DB_USERNAME: 'app', DB_PASSWORD: 'p@ss/w:rd', DB_NAME: 'dailytasks' };

  it('requires TLS and URL-encodes credentials', () => {
    const env: Record<string, string | undefined> = { ...base };
    ensureDatabaseUrl(env);
    expect(env.DATABASE_URL).toBe('postgresql://app:p%40ss%2Fw%3Ard@db.internal:5432/dailytasks?schema=public&sslmode=require&connection_limit=10');
  });

  it('verifies the server certificate when the RDS CA bundle is configured', () => {
    const env: Record<string, string | undefined> = { ...base, DB_SSL_CA_FILE: '/app/certs/rds-global-bundle.pem' };
    ensureDatabaseUrl(env);
    expect(env.DATABASE_URL).toContain('sslmode=require&sslcert=%2Fapp%2Fcerts%2Frds-global-bundle.pem&sslaccept=strict');
  });

  it('never overrides an explicit DATABASE_URL', () => {
    const env: Record<string, string | undefined> = { ...base, DATABASE_URL: 'postgresql://x' };
    ensureDatabaseUrl(env);
    expect(env.DATABASE_URL).toBe('postgresql://x');
  });
});
