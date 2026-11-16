import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { request, type FullConfig } from '@playwright/test';

export const AUTH_DIR = join(__dirname, '.auth');
export const DEMO_USERS = ['admin@dailytasks.local', 'manager1@dailytasks.local', 'employee1@dailytasks.local', 'employee2@dailytasks.local'];
export const authFile = (email: string) => join(AUTH_DIR, `${email}.json`);

/**
 * Signs each demo user in exactly once through the real web login (BFF → API) and saves the
 * session. Tests reuse these sessions, so the suite stays within the API's per-IP sign-in limit
 * (10/minute) — the limit itself is intentionally not relaxed for tests.
 */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL ?? 'http://localhost:3001';
  const password = process.env.SEED_DEMO_PASSWORD ?? 'Password123!';
  mkdirSync(AUTH_DIR, { recursive: true });
  for (const email of DEMO_USERS) {
    for (let attempt = 1; ; attempt++) {
      const ctx = await request.newContext({ baseURL });
      const res = await ctx.post('/session/login', { data: { email, password } });
      if (res.ok()) {
        await ctx.storageState({ path: authFile(email) });
        await ctx.dispose();
        break;
      }
      await ctx.dispose();
      if (res.status() !== 429 || attempt >= 3) throw new Error(`global setup: login for ${email} failed (${res.status()})`);
      await new Promise((r) => setTimeout(r, 61_000)); // previous run used up this minute's sign-ins
    }
  }
}
