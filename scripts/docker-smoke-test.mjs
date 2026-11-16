#!/usr/bin/env node
/**
 * Docker integration / end-to-end smoke test against the running compose stack.
 *   docker compose up -d --build && pnpm test:docker
 *
 * Exercises the real API, worker (outbox -> SQS -> notifications), LocalStack S3 pre-signed
 * uploads, the local deadline scheduler, the web BFF login flow, and Web Push: a fake push service
 * on the host (reached by the worker via host.docker.internal) receives the real VAPID-signed,
 * aes128gcm-encrypted pushes and decrypts them with the "browser" keys.
 * Uses the demo seed accounts (SEED_DEMO_PASSWORD, default Password123!).
 */
const API = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const WEB = process.env.WEB_URL ?? 'http://localhost:3001';
const PASSWORD = process.env.SEED_DEMO_PASSWORD ?? 'Password123!';

let passed = 0;
const step = async (name, fn) => {
  const t = Date.now();
  try {
    await fn();
    passed++;
    console.info(`  ✓ ${name} (${Date.now() - t}ms)`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exit(1);
  }
};
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- fake push service (stands in for FCM / Apple) ---------------- */
import { createECDH, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const ece = createRequire(new URL('../apps/worker/package.json', import.meta.url))('http_ece');

const pushInbox = []; // { path, headers, payload }
const pushStatus = new Map(); // path -> status code to answer
const pushServer = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const device = devices.find((d) => req.url === d.path);
    let payload = null;
    if (device) {
      try {
        payload = JSON.parse(ece.decrypt(Buffer.concat(chunks), { version: 'aes128gcm', privateKey: device.ecdh, authSecret: device.auth }).toString('utf8'));
      } catch (e) {
        payload = { decryptError: e.message };
      }
    }
    pushInbox.push({ path: req.url, headers: req.headers, payload });
    res.writeHead(pushStatus.get(req.url) ?? 201).end();
  });
});
await new Promise((r) => pushServer.listen(0, '0.0.0.0', r));
const PUSH_HOST = process.env.SMOKE_PUSH_HOST ?? 'host.docker.internal';
const pushBase = `http://${PUSH_HOST}:${pushServer.address().port}`;
const devices = [];
function fakeDevice(name) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const d = { name, ecdh, auth: randomBytes(16).toString('base64url'), path: `/push/${name}-${Date.now()}` };
  devices.push(d);
  return { d, subscription: { endpoint: `${pushBase}${d.path}`, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: d.auth } } };
}
process.on('exit', () => pushServer.close());

async function call(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(email) {
  const r = await call(null, 'POST', '/auth/login', { email, password: PASSWORD });
  assert(r.status === 200 && r.body.status === 'OK', `login failed for ${email}: ${r.status}`);
  return r.body;
}

async function waitFor(fn, what, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

console.info('DailyTasks docker smoke test');
let manager, employee, otherEmployee, task, attachmentId, departmentId, submissionId;

await step('API and web health checks', async () => {
  assert((await fetch(API.replace('/api/v1', '/health'))).ok, 'api /health');
  assert((await fetch(`${WEB}/health`)).ok, 'web /health');
});

await step('login (manager, employee)', async () => {
  manager = await login('manager1@dailytasks.local');
  employee = await login('employee1@dailytasks.local');
  otherEmployee = await login('employee2@dailytasks.local');
});

await step('web BFF login sets httpOnly cookies and proxies the API', async () => {
  const res = await fetch(`${WEB}/session/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB },
    body: JSON.stringify({ email: 'manager1@dailytasks.local', password: PASSWORD }),
  });
  assert(res.ok, `web login ${res.status}`);
  const body = await res.json();
  assert(!('accessToken' in body), 'tokens must not be returned to the browser');
  const cookies = res.headers.getSetCookie();
  assert(cookies.some((c) => c.startsWith('dt_access=') && /HttpOnly/i.test(c)), 'httpOnly access cookie');
  const cookieHeader = cookies.map((c) => c.split(';')[0]).join('; ');
  const dash = await fetch(`${WEB}/bff/dashboard`, { headers: { Cookie: cookieHeader } });
  assert(dash.ok, `bff dashboard ${dash.status}`);
  const cross = await fetch(`${WEB}/bff/tasks`, { method: 'POST', headers: { Cookie: cookieHeader, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
  assert(cross.status === 403, 'cross-origin mutation must be rejected');
});

let phone, oldPhone;
await step('employee enables Web Push on two devices (one will report 410 Gone)', async () => {
  const key = await call(null, 'GET', '/push/vapid-public-key');
  assert(key.status === 200 && key.body.enabled && key.body.publicKey, 'VAPID public key served');
  phone = fakeDevice('phone');
  oldPhone = fakeDevice('old-phone');
  pushStatus.set(oldPhone.d.path, 410);
  for (const dev of [phone, oldPhone]) {
    const r = await call(employee.accessToken, 'POST', '/push/subscribe', dev.subscription);
    assert(r.status === 201, `subscribe ${r.status} ${JSON.stringify(r.body)}`);
  }
  const evil = await call(employee.accessToken, 'POST', '/push/subscribe', { ...phone.subscription, endpoint: 'https://evil.example.com/push/x' });
  assert(evil.status === 400, 'non push-service endpoint must be rejected');
});

await step('manager creates a task (deadline in 90 minutes) in the employee\'s department', async () => {
  const projectId = manager.user.managedProjectIds[0];
  departmentId = employee.user.departments.find((d) => d.isPrimary).id;
  const eligible = await call(manager.accessToken, 'GET', `/departments/${departmentId}/assignable-employees?projectId=${projectId}`);
  assert(eligible.status === 200 && eligible.body.some((u) => u.id === employee.user.id), 'employee assignable in department');
  const r = await call(manager.accessToken, 'POST', '/tasks', {
    projectId,
    departmentId,
    priority: 'HIGH',
    assigneeId: employee.user.id,
    title: `Smoke test ${new Date().toISOString()}`,
    description: 'Created by docker smoke test',
    deadline: new Date(Date.now() + 90 * 60_000).toISOString(),
  });
  assert(r.status === 201, `create task ${r.status} ${JSON.stringify(r.body)}`);
  task = r.body;
});

await step('worker delivers TASK_ASSIGNED notification to the employee (outbox -> SQS -> worker)', async () => {
  await waitFor(async () => {
    const r = await call(employee.accessToken, 'GET', '/notifications?pageSize=50');
    return r.body.items.find((n) => n.taskId === task.id && n.type === 'TASK_ASSIGNED');
  }, 'TASK_ASSIGNED notification');
});

await step('worker sends an encrypted Web Push the device can decrypt; 410 device is deactivated', async () => {
  const got = await waitFor(() => pushInbox.find((m) => m.path === phone.d.path && m.payload?.taskId === task.id), 'push at the fake push service');
  assert(got.payload.type === 'TASK_ASSIGNED', `payload type ${got.payload.type}`);
  assert(got.payload.url === `/tasks/${task.id}`, `deep link ${got.payload.url}`);
  assert(got.payload.title && got.payload.body, 'title and body present');
  assert(String(got.headers.authorization).startsWith('vapid t='), 'VAPID Authorization header');
  assert(got.headers['content-encoding'] === 'aes128gcm', 'aes128gcm encoding');
  assert(Number(got.headers.ttl) > 0, 'TTL header');
  const status = await waitFor(async () => {
    const r = await call(employee.accessToken, 'GET', '/push/status');
    const inactive = r.body.subscriptions.find((s) => !s.isActive && s.deactivationReason === 'push service returned 410');
    const sent = r.body.subscriptions.find((s) => s.isActive && s.lastDelivery?.status === 'SENT' && s.lastDelivery.statusCode === 201);
    return inactive && sent ? r.body : null;
  }, 'delivery status: one SENT, one deactivated');
  assert(!JSON.stringify(status).includes(phone.subscription.keys.auth), 'status never exposes subscription secrets');
});

await step('other employee cannot see the task', async () => {
  const r = await call(otherEmployee.accessToken, 'GET', `/tasks/${task.id}`);
  assert(r.status === 404, `expected 404, got ${r.status}`);
});

await step('new task is not overdue', async () => {
  const r = await call(employee.accessToken, 'GET', '/notifications?pageSize=50');
  assert(!r.body.items.some((n) => n.taskId === task.id && n.type === 'TASK_OVERDUE'), 'must not be overdue');
});

await step('employee uploads a photo via pre-signed S3 URL (LocalStack)', async () => {
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(200).fill(7)]);
  const up = await call(employee.accessToken, 'POST', `/tasks/${task.id}/attachments/upload-url`, { fileName: 'site-photo.jpg', contentType: 'image/jpeg', sizeBytes: bytes.length });
  assert(up.status === 201, `upload-url ${up.status}`);
  const put = await fetch(up.body.uploadUrl, { method: 'PUT', headers: up.body.headers, body: bytes });
  assert(put.ok, `S3 PUT ${put.status} ${await put.text()}`);
  const confirm = await call(employee.accessToken, 'POST', `/attachments/${up.body.attachmentId}/confirm`);
  assert(confirm.status === 200, `confirm ${confirm.status} ${JSON.stringify(confirm.body)}`);
  attachmentId = up.body.attachmentId;
  const bad = await call(employee.accessToken, 'POST', `/tasks/${task.id}/attachments/upload-url`, { fileName: 'x.exe', contentType: 'application/x-msdownload', sizeBytes: 10 });
  assert(bad.status === 400, 'invalid type must be rejected');
});

await step('empty completion comment is rejected; submission with comment goes to PENDING_REVIEW', async () => {
  const bad = await call(employee.accessToken, 'POST', `/tasks/${task.id}/submissions`, { comment: '  ' });
  assert(bad.status === 400, `expected 400, got ${bad.status}`);
  const ok = await call(employee.accessToken, 'POST', `/tasks/${task.id}/submissions`, { comment: 'Finished, photo attached', attachmentIds: [attachmentId] });
  assert(ok.status === 201 && ok.body.status === 'PENDING' && ok.body.stage === 'MANAGER', `submit ${ok.status} ${JSON.stringify(ok.body)}`);
  submissionId = ok.body.id;
  const t = await call(employee.accessToken, 'GET', `/tasks/${task.id}`);
  assert(t.body.status === 'PENDING_REVIEW' && t.body.time.paused === true, 'task pending review with paused clock');
  const self = await call(employee.accessToken, 'POST', `/submissions/${submissionId}/approve`, {});
  assert(self.status === 403, `employee must not self-approve (${self.status})`);
});

await step('manager is notified (TASK_SUBMITTED), approves; employee notified (TASK_APPROVED); files registered as project documents', async () => {
  await waitFor(async () => {
    const r = await call(manager.accessToken, 'GET', '/notifications?pageSize=50');
    return r.body.items.find((n) => n.taskId === task.id && n.type === 'TASK_SUBMITTED');
  }, 'TASK_SUBMITTED notification');
  const ok = await call(manager.accessToken, 'POST', `/submissions/${submissionId}/approve`, { note: 'Approved by smoke test' });
  assert(ok.status === 200 && ok.body.status === 'APPROVED', `approve ${ok.status} ${JSON.stringify(ok.body)}`);
  const t = await call(employee.accessToken, 'GET', `/tasks/${task.id}`);
  assert(t.body.status === 'COMPLETED' && t.body.completedLate === false, `completed on time (${t.body.status})`);
  await waitFor(async () => {
    const r = await call(employee.accessToken, 'GET', '/notifications?pageSize=50');
    return r.body.items.find((n) => n.taskId === task.id && n.type === 'TASK_APPROVED');
  }, 'TASK_APPROVED notification');
  const docs = await call(manager.accessToken, 'GET', `/projects/${task.projectId}/documents?taskId=${task.id}`);
  assert(docs.status === 200 && docs.body.total === 1 && docs.body.items[0].source === 'TASK_SUBMISSION', `document registered (${JSON.stringify(docs.body)})`);
  const empDocs = await call(employee.accessToken, 'GET', `/documents/${docs.body.items[0].id}/download-url`);
  assert(empDocs.status === 404, 'managers-only document hidden from employee');
  const dl = await call(manager.accessToken, 'GET', `/documents/${docs.body.items[0].id}/download-url`);
  assert(dl.status === 200, `document download-url ${dl.status}`);
  const file = await fetch(dl.body.url);
  assert(file.ok && (await file.arrayBuffer()).byteLength === 204, 'downloaded bytes (same S3 object)');
});

await step('manager requests an Arabic PDF report; worker renders it with Chromium; download is a real PDF', async () => {
  const r = await call(manager.accessToken, 'POST', '/reports', { type: 'TASK', taskId: task.id, locale: 'ar' });
  assert(r.status === 201 && r.body.status === 'QUEUED', `report ${r.status} ${JSON.stringify(r.body)}`);
  const job = await waitFor(async () => {
    const j = await call(manager.accessToken, 'GET', `/reports/${r.body.id}`);
    if (j.body.status === 'FAILED') throw new Error(`report failed: ${j.body.error}`);
    return j.body.status === 'READY' ? j.body : null;
  }, 'report READY', 90_000);
  assert(job.sizeBytes > 5000, `pdf size ${job.sizeBytes}`);
  const dl = await call(manager.accessToken, 'GET', `/reports/${r.body.id}/download-url`);
  const pdf = Buffer.from(await (await fetch(dl.body.url)).arrayBuffer());
  assert(pdf.subarray(0, 5).toString() === '%PDF-', 'downloaded file is a PDF');
  const other = await call(employee.accessToken, 'GET', `/reports/${r.body.id}`);
  assert(other.status === 404, 'reports are private to the requester');
});

await step('personal tasks are private to their owner', async () => {
  const p = await call(employee.accessToken, 'POST', '/me/personal-tasks', { title: 'Smoke personal note' });
  assert(p.status === 201, `personal create ${p.status}`);
  const peek = await call(manager.accessToken, 'GET', `/me/personal-tasks/${p.body.id}`);
  assert(peek.status === 404, 'manager cannot read personal task');
  const del = await call(employee.accessToken, 'DELETE', `/me/personal-tasks/${p.body.id}`);
  assert(del.status === 204, `personal delete ${del.status}`);
});

await step('manager rates the task; employee cannot see ratings', async () => {
  const r = await call(manager.accessToken, 'PUT', `/tasks/${task.id}/rating`, { stars: 5, feedback: 'Great work' });
  assert(r.status === 200, `rate ${r.status}`);
  const e1 = await call(employee.accessToken, 'GET', `/tasks/${task.id}/rating`);
  const e2 = await call(employee.accessToken, 'GET', `/performance/employees/${employee.user.id}`);
  assert(e1.status === 403 && e2.status === 403, 'employee must be forbidden');
  const perf = await call(manager.accessToken, 'GET', `/performance/employees/${employee.user.id}`);
  assert(perf.status === 200 && perf.body.ratedTaskCount >= 1, 'performance visible to manager');
});

await step('reopen notifies the employee', async () => {
  const r = await call(manager.accessToken, 'POST', `/tasks/${task.id}/reopen`, { reason: 'Please add a second photo', deadline: new Date(Date.now() + 3 * 3600_000).toISOString() });
  assert(r.status === 200 && r.body.status === 'ASSIGNED', `reopen ${r.status}`);
  await waitFor(async () => {
    const n = await call(employee.accessToken, 'GET', '/notifications?pageSize=50');
    return n.body.items.find((x) => x.taskId === task.id && x.type === 'TASK_REOPENED');
  }, 'TASK_REOPENED notification');
});

await step('deadline passes -> local scheduler + worker send TASK_OVERDUE to employee and manager (~70s)', async () => {
  const projectId = manager.user.managedProjectIds[0];
  const r = await call(manager.accessToken, 'POST', '/tasks', {
    projectId,
    departmentId,
    assigneeId: employee.user.id,
    title: `Overdue smoke ${Date.now()}`,
    deadline: new Date(Date.now() + 60_000).toISOString(),
  });
  assert(r.status === 201, `create ${r.status}`);
  const id = r.body.id;
  for (const who of [employee, manager]) {
    await waitFor(async () => {
      const n = await call(who.accessToken, 'GET', '/notifications?pageSize=50');
      return n.body.items.find((x) => x.taskId === id && x.type === 'TASK_OVERDUE');
    }, 'TASK_OVERDUE notification', 120_000);
  }
});

await step('test notification goes through the outbox to this user only; duplicates suppressed', async () => {
  const before = pushInbox.length;
  const r = await call(employee.accessToken, 'POST', '/push/test');
  assert(r.status === 202 && r.body.queued, `test push ${r.status}`);
  const got = await waitFor(() => pushInbox.slice(before).find((m) => m.payload?.type === 'PUSH_TEST'), 'PUSH_TEST push');
  assert(got.path === phone.d.path, 'delivered to the active device');
  assert(got.payload.url === '/settings/notifications', 'test push deep link');
  await sleep(3000);
  const tests = pushInbox.slice(before).filter((m) => m.payload?.type === 'PUSH_TEST');
  assert(tests.length === 1, `exactly one test push, got ${tests.length}`);
  assert(!pushInbox.slice(before).some((m) => m.path === oldPhone.d.path), 'deactivated device not used again');
  const un = await call(employee.accessToken, 'DELETE', '/push/unsubscribe', { endpoint: phone.subscription.endpoint });
  assert(un.status === 204, `unsubscribe ${un.status}`);
});

await step('Swagger/OpenAPI document is served', async () => {
  const r = await fetch(API.replace('/api/v1', '/api/docs-json'));
  assert(r.ok, `swagger ${r.status}`);
  const doc = await r.json();
  assert(doc.paths['/api/v1/tasks'], 'tasks path documented');
  assert(doc.paths['/api/v1/push/subscribe'], 'push paths documented');
});

console.info(`\nAll ${passed} smoke-test steps passed.`);
pushServer.close();
