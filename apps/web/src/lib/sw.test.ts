import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

/**
 * Loads public/sw.js into a sandbox with fake service-worker globals and lets tests dispatch
 * push / notificationclick events. Covers payload parsing, display options, badge, deep-link
 * safety and focus/open behaviour.
 */
function loadServiceWorker(opts: { windows?: FakeClient[] } = {}) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const fetches: Array<{ url: string; method?: string }> = [];
  const badges: Array<number | 'clear'> = [];
  const windows = opts.windows ?? [];
  const self = {
    location: { origin: 'https://app.example.com' },
    addEventListener: (type: string, fn: (e: unknown) => void) => (listeners[type] = fn),
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }),
      navigationPreload: null,
      pushManager: {},
    },
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => void opened.push(url),
      claim: async () => undefined,
    },
    navigator: {
      setAppBadge: async (n: number) => void badges.push(n),
      clearAppBadge: async () => void badges.push('clear'),
    },
    skipWaiting: async () => undefined,
  };
  const context = vm.createContext({
    self,
    caches: { open: async () => ({}), keys: async () => [] },
    fetch: async (url: string, init?: { method?: string }) => {
      fetches.push({ url, method: init?.method });
      return { ok: true, json: async () => ({ count: 2 }) };
    },
    URL,
    Response,
    Request,
    MessageChannel,
    setTimeout,
    clearTimeout,
    atob,
    Uint8Array,
    console,
  });
  vm.runInContext(readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8'), context);

  async function dispatch(type: string, event: Record<string, unknown>) {
    let pending: Promise<unknown> = Promise.resolve();
    listeners[type]!({ ...event, waitUntil: (p: Promise<unknown>) => (pending = p) });
    await pending;
  }
  const push = (data: unknown) => dispatch('push', { data: { json: () => (typeof data === 'string' ? JSON.parse(data) : data), text: () => String(data) } });
  const click = (data: Record<string, unknown>) => {
    const close = vi.fn();
    return dispatch('notificationclick', { notification: { data, close } }).then(() => close);
  };
  return { push, click, shown, opened, fetches, badges };
}

interface FakeClient {
  url: string;
  focused: boolean;
  focus: () => Promise<void>;
  postMessage: (msg: unknown, ports?: MessagePort[]) => void;
  navigate?: (url: string) => Promise<void>;
  messages: unknown[];
}

function fakeWindow(url: string, { acks = true, focused = false } = {}): FakeClient {
  const c: FakeClient = {
    url,
    focused,
    messages: [],
    focus: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
    postMessage: (msg, ports) => {
      c.messages.push(msg);
      if (acks && (msg as { type: string }).type === 'dt:navigate') ports?.[0]?.postMessage('ok');
    },
  };
  return c;
}

const TASK = '3f2b8c1e-1d2a-4b5c-9e8f-0a1b2c3d4e5f';

describe('service worker: push', () => {
  it('shows an OS notification with icon, badge, tag and deep-link data; updates the app badge', async () => {
    const sw = loadServiceWorker();
    await sw.push({ v: 1, notificationId: 'n1', type: 'TASK_ASSIGNED', title: 'New task assigned', body: 'Fix door · HQ', url: `/tasks/${TASK}`, taskId: TASK, badgeCount: 4, tag: 'n-n1' });
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]!.title).toBe('New task assigned');
    expect(sw.shown[0]!.options).toMatchObject({
      body: 'Fix door · HQ',
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-96.png',
      tag: 'n-n1',
      requireInteraction: false,
      data: { path: `/tasks/${TASK}`, notificationId: 'n1', taskId: TASK },
    });
    expect(sw.badges).toEqual([4]);
  });

  it('always shows something, even for an unparseable payload (Safari revokes silent pushes)', async () => {
    const sw = loadServiceWorker();
    await sw.push('not json');
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]!.title).toBe('الراسيات');
  });

  it('never deep-links outside the app', async () => {
    const sw = loadServiceWorker();
    for (const url of ['https://evil.example.com/phish', '//evil.example.com', 'javascript:alert(1)', '/\\evil.example.com']) {
      await sw.push({ title: 't', body: 'b', url, notificationId: 'x' });
    }
    await sw.push({ title: 't', body: 'b', url: 'https://evil.example.com', taskId: TASK });
    const paths = sw.shown.map((s) => (s.options.data as { path: string }).path);
    expect(paths.slice(0, 4).every((p) => p === '/notifications')).toBe(true);
    expect(paths[4]).toBe(`/tasks/${TASK}`);
  });

  it('tells open windows to refresh', async () => {
    const win = fakeWindow('https://app.example.com/');
    const sw = loadServiceWorker({ windows: [win] });
    await sw.push({ title: 't', body: 'b', notificationId: 'n2', taskId: TASK, url: `/tasks/${TASK}` });
    expect(win.messages).toContainEqual({ type: 'dt:push', notificationId: 'n2', taskId: TASK });
  });
});

describe('service worker: notification click', () => {
  it('app closed: opens the app on the task and marks the notification read', async () => {
    const sw = loadServiceWorker();
    const close = await sw.click({ path: `/tasks/${TASK}`, notificationId: 'n1', taskId: TASK });
    expect(close).toHaveBeenCalled();
    expect(sw.opened).toEqual([`https://app.example.com/tasks/${TASK}`]);
    expect(sw.fetches[0]).toEqual({ url: '/bff/notifications/n1/read', method: 'POST' });
    expect(sw.badges).toEqual([2]); // refreshed unread count
  });

  it('app open in the background: focuses it and navigates in-app (no new window)', async () => {
    const win = fakeWindow('https://app.example.com/projects');
    const sw = loadServiceWorker({ windows: [win] });
    await sw.click({ path: `/tasks/${TASK}`, notificationId: 'n1' });
    expect(win.focus).toHaveBeenCalled();
    expect(win.messages).toContainEqual({ type: 'dt:navigate', path: `/tasks/${TASK}` });
    expect(win.navigate).not.toHaveBeenCalled();
    expect(sw.opened).toEqual([]);
  });

  it('window that does not answer (e.g. offline page): falls back to a full navigation', async () => {
    const win = fakeWindow('https://app.example.com/offline.html', { acks: false });
    const sw = loadServiceWorker({ windows: [win] });
    await sw.click({ path: `/tasks/${TASK}` });
    expect(win.navigate).toHaveBeenCalledWith(`https://app.example.com/tasks/${TASK}`);
    expect(sw.opened).toEqual([]);
  });

  it('ignores windows of other origins and never opens external URLs', async () => {
    const other = fakeWindow('https://other.example.com/');
    const sw = loadServiceWorker({ windows: [other] });
    await sw.click({ path: 'https://evil.example.com/' });
    expect(other.focus).not.toHaveBeenCalled();
    expect(sw.opened).toEqual(['https://app.example.com/notifications']);
  });
});
