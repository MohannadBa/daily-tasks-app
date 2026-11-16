#!/usr/bin/env node
/**
 * Docker integration / end-to-end smoke test against the running compose stack.
 *   docker compose up -d --build && pnpm test:docker
 *
 * Exercises the real API, worker (outbox -> SQS -> notifications), LocalStack S3 pre-signed
 * uploads, the local deadline scheduler, and the web BFF login flow.
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
let manager, employee, otherEmployee, task, attachmentId;

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

await step('manager creates a task (deadline in 90 minutes)', async () => {
  const projectId = manager.user.managedProjectIds[0];
  const r = await call(manager.accessToken, 'POST', '/tasks', {
    projectId,
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

await step('empty completion comment is rejected; completion with comment succeeds', async () => {
  const bad = await call(employee.accessToken, 'POST', `/tasks/${task.id}/complete`, { comment: '  ' });
  assert(bad.status === 400, `expected 400, got ${bad.status}`);
  const ok = await call(employee.accessToken, 'POST', `/tasks/${task.id}/complete`, { comment: 'Finished, photo attached', attachmentIds: [attachmentId] });
  assert(ok.status === 200 && ok.body.status === 'COMPLETED' && ok.body.completedLate === false, `complete ${ok.status}`);
});

await step('manager receives TASK_COMPLETED notification and can download the attachment', async () => {
  await waitFor(async () => {
    const r = await call(manager.accessToken, 'GET', '/notifications?pageSize=50');
    return r.body.items.find((n) => n.taskId === task.id && n.type === 'TASK_COMPLETED');
  }, 'TASK_COMPLETED notification');
  const dl = await call(manager.accessToken, 'GET', `/attachments/${attachmentId}/download-url`);
  assert(dl.status === 200, `download-url ${dl.status}`);
  const file = await fetch(dl.body.url);
  assert(file.ok && (await file.arrayBuffer()).byteLength === 204, 'downloaded bytes');
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

await step('Swagger/OpenAPI document is served', async () => {
  const r = await fetch(API.replace('/api/v1', '/api/docs-json'));
  assert(r.ok, `swagger ${r.status}`);
  const doc = await r.json();
  assert(doc.paths['/api/v1/tasks'], 'tasks path documented');
});

console.info(`\nAll ${passed} smoke-test steps passed.`);
