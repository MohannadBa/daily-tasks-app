#!/usr/bin/env node
/**
 * Cognito integration test against a REAL staging deployment (AUTH_MODE=cognito).
 * It only talks to the staging API over HTTPS — it creates no AWS resources.
 *
 *   STAGING_URL=https://staging.tasks.example.com \
 *   ADMIN_EMAIL=<bootstrap admin> ADMIN_PASSWORD=<their password> \
 *   TEST_EMAIL_DOMAIN=<domain you control, e.g. qa.example.com> \
 *   node scripts/cognito-staging-test.mjs
 *
 * Automates the flows that do not require reading an inbox (SHOW_ONCE temporary passwords).
 * E-mail delivery (default EMAIL invitation + e-mailed reset code) is covered by the manual steps
 * in docs/COGNITO_TESTS.md. Passwords and tokens are never printed. Accounts it creates are
 * deactivated at the end (Cognito users can be deleted by an operator afterwards).
 */
import { randomBytes } from 'node:crypto';

const BASE = `${(process.env.STAGING_URL ?? '').replace(/\/$/, '')}/api/v1`;
// Works against staging or production. In restricted acceptance mode set TEST_EMAIL to an address that
// is in ACCESS_ALLOWLIST and does not exist yet (the run deactivates it; use a new address per run).
const { ADMIN_EMAIL, ADMIN_PASSWORD, TEST_EMAIL } = process.env;
const TEST_EMAIL_DOMAIN = process.env.TEST_EMAIL_DOMAIN ?? TEST_EMAIL?.split('@')[1];
if (!process.env.STAGING_URL?.startsWith('https://') || !ADMIN_EMAIL || !ADMIN_PASSWORD || !TEST_EMAIL_DOMAIN) {
  console.error('Set STAGING_URL (https URL of the environment), ADMIN_EMAIL, ADMIN_PASSWORD and TEST_EMAIL_DOMAIN (or TEST_EMAIL).');
  process.exit(2);
}

const results = [];
const step = async (id, name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ id, name, result: 'PASS', ms: Date.now() - t0 });
    console.info(`  ✓ ${id} ${name}`);
  } catch (e) {
    results.push({ id, name, result: 'FAIL', error: e.message });
    console.error(`  ✗ ${id} ${name}: ${e.message}`);
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m);
};
async function call(method, path, body, token) {
  const r = await fetch(`${BASE}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  return { status: r.status, body: json };
}
const strongPassword = () => `Qa${randomBytes(9).toString('base64url')}9`;

console.info(`Cognito staging test → ${new URL(BASE).host}`);
let admin, user, temp, session, pw1, pw2, oldTokens;
const email = (TEST_EMAIL ?? `cognito-qa-${Date.now()}@${TEST_EMAIL_DOMAIN}`).toLowerCase();

await step('C0', 'admin signs in (Cognito)', async () => {
  const r = await call('POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  assert(r.status === 200 && r.body?.status === 'OK', `login ${r.status}`);
  admin = r.body.accessToken;
  const me = await call('GET', '/auth/me', null, admin);
  assert(me.body?.role === 'ADMIN', 'bootstrap user is not ADMIN');
});

await step('C1', 'admin creates an employee (SHOW_ONCE temporary password)', async () => {
  const depts = (await call('GET', '/departments', null, admin)).body;
  const r = await call('POST', '/users', { email, name: 'Cognito QA', role: 'EMPLOYEE', passwordDelivery: 'SHOW_ONCE', departments: [{ departmentId: depts[0].id, isPrimary: true }] }, admin);
  assert(r.status === 201, `create ${r.status} ${JSON.stringify(r.body)}`);
  assert(typeof r.body.temporaryPassword === 'string' && r.body.temporaryPassword.length >= 12, 'temporary password returned once');
  assert(r.body.mustChangePassword === true, 'mustChangePassword');
  user = r.body;
  temp = r.body.temporaryPassword;
  const again = await call('GET', `/users/${user.id}`, null, admin);
  assert(!JSON.stringify(again.body).includes(temp), 'temporary password must never be returned again');
});

await step('C2', 'login with the temporary password returns NEW_PASSWORD_REQUIRED and no tokens', async () => {
  const r = await call('POST', '/auth/login', { email, password: temp });
  assert(r.status === 200 && r.body?.status === 'NEW_PASSWORD_REQUIRED', `got ${r.status} ${r.body?.status}`);
  assert(!r.body.accessToken, 'no tokens before the password change');
  session = r.body.session;
});

await step('C3', 'wrong password is rejected generically', async () => {
  const r = await call('POST', '/auth/login', { email, password: 'Wrong-password-1' });
  assert(r.status === 401, `expected 401, got ${r.status}`);
});

await step('C4', 'policy-violating new password is refused; a valid one completes the challenge', async () => {
  const weak = await call('POST', '/auth/new-password', { email, session, newPassword: 'short' });
  assert(weak.status === 400, `weak password should be 400 (got ${weak.status})`);
  pw1 = strongPassword();
  const r = await call('POST', '/auth/new-password', { email, session, newPassword: pw1 });
  assert(r.status === 200 && r.body?.status === 'OK' && r.body.accessToken, `complete ${r.status}`);
  assert(r.body.user.mustChangePassword === false, 'flag cleared');
});

await step('C5', 'the temporary password no longer works; normal login with the new password does', async () => {
  const old = await call('POST', '/auth/login', { email, password: temp });
  assert(old.status === 401, `temporary password must be dead (got ${old.status})`);
  const r = await call('POST', '/auth/login', { email, password: pw1 });
  assert(r.status === 200 && r.body?.status === 'OK', `login ${r.status}`);
  oldTokens = { access: r.body.accessToken, refresh: r.body.refreshToken };
  assert((await call('GET', '/tasks', null, oldTokens.access)).status === 200, 'API access with a Cognito token');
});

await step('C6', 'authenticated password change (Cognito ChangePassword)', async () => {
  pw2 = strongPassword();
  const r = await call('POST', '/auth/change-password', { currentPassword: pw1, newPassword: pw2 }, oldTokens.access);
  assert(r.status === 204, `change ${r.status}`);
  assert((await call('POST', '/auth/login', { email, password: pw1 })).status === 401, 'old password rejected');
  const ok = await call('POST', '/auth/login', { email, password: pw2 });
  assert(ok.status === 200 && ok.body.status === 'OK', 'new password works');
  oldTokens = { access: ok.body.accessToken, refresh: ok.body.refreshToken };
});

await step('C7', 'admin password reset revokes sessions (global sign-out) and forces a new password', async () => {
  const r = await call('POST', `/users/${user.id}/reset-password`, { passwordDelivery: 'SHOW_ONCE' }, admin);
  assert(r.status === 200 && r.body.temporaryPassword, `reset ${r.status}`);
  const refresh = await call('POST', '/auth/refresh', { refreshToken: oldTokens.refresh });
  assert(refresh.status === 401, `refresh token must be revoked (got ${refresh.status})`);
  const blocked = await call('GET', '/tasks', null, oldTokens.access);
  assert(blocked.status === 401 || (blocked.status === 403 && blocked.body?.code === 'PASSWORD_CHANGE_REQUIRED'), `old access token must not work normally (got ${blocked.status})`);
  const login = await call('POST', '/auth/login', { email, password: r.body.temporaryPassword });
  assert(login.body?.status === 'NEW_PASSWORD_REQUIRED', 'reset forces a new password');
  const done = await call('POST', '/auth/new-password', { email, session: login.body.session, newPassword: strongPassword() });
  assert(done.status === 200, 'complete after reset');
  oldTokens = { access: done.body.accessToken, refresh: done.body.refreshToken };
});

await step('C8', 'deactivation disables the Cognito user and revokes access immediately', async () => {
  const r = await call('PATCH', `/users/${user.id}`, { isActive: false }, admin);
  assert(r.status === 200 && r.body.isActive === false, `deactivate ${r.status}`);
  assert((await call('GET', '/auth/me', null, oldTokens.access)).status === 401, 'access token refused at once');
  assert((await call('POST', '/auth/refresh', { refreshToken: oldTokens.refresh })).status === 401, 'refresh revoked');
  assert((await call('POST', '/auth/login', { email, password: pw2 })).status === 401, 'login refused');
});

await step('C9', 'forgot-password never reveals whether an account exists', async () => {
  const a = await call('POST', '/auth/forgot-password', { email: `nobody-${Date.now()}@${TEST_EMAIL_DOMAIN}` });
  const b = await call('POST', '/auth/forgot-password', { email });
  assert(a.status === 202 && b.status === 202 && JSON.stringify(a.body) === JSON.stringify(b.body), `same response for unknown/known (${a.status}/${b.status})`);
});

console.info('\nResults (paste into docs/COGNITO_TESTS.md):');
console.table(results.map(({ id, name, result, error }) => ({ id, name, result, error: error ?? '' })));
process.exit(results.some((r) => r.result === 'FAIL') ? 1 : 0);
