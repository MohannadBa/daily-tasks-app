import { describe, expect, it, vi } from 'vitest';
import { backoffDelay, RealtimeClient, resolveRealtimeUrl } from './realtime';

/** Minimal fake WebSocket the client can drive. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed: number | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  open(userId = 'u1') {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify({ type: 'hello', userId, heartbeatMs: 25000 }) });
  }
  emit(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  close(code = 1000) {
    this.closed = code;
    this.readyState = 3;
  }
}

function setup(refresh = vi.fn(async () => true)) {
  FakeSocket.instances = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const events: unknown[] = [];
  const statuses: string[] = [];
  const client = new RealtimeClient({
    url: 'ws://x/api/v1/realtime',
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    refreshSession: refresh,
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    random: () => 0.5,
    setTimer: (fn, ms) => timers.push({ fn, ms }),
    clearTimer: () => undefined,
  });
  const runTimer = () => timers.shift()!.fn();
  return { client, timers, events, statuses, refresh, runTimer, last: () => FakeSocket.instances.at(-1)! };
}

describe('RealtimeClient', () => {
  it('connects, reports open on hello and forwards events', () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().emit({ type: 'event', event: { kind: 'notification', type: 'TASK_ASSIGNED', taskId: 't1' } });
    expect(t.statuses).toEqual(['connecting', 'open']);
    expect(t.events).toEqual([{ kind: 'notification', type: 'TASK_ASSIGNED', taskId: 't1' }]);
  });

  it('reconnects with exponential backoff after a dropped connection, and resets after success', () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().drop();
    expect(t.timers[0]!.ms).toBe(backoffDelay(0, () => 0.5));
    t.runTimer();
    t.last().drop();
    expect(t.timers[0]!.ms).toBe(backoffDelay(1, () => 0.5));
    expect(t.timers[0]!.ms).toBeGreaterThan(backoffDelay(0, () => 0.5));
    t.runTimer();
    t.last().open();
    expect(t.client.currentStatus).toBe('open');
    t.last().drop();
    expect(t.timers[0]!.ms).toBe(backoffDelay(0, () => 0.5)); // attempt counter reset
    expect(FakeSocket.instances).toHaveLength(3);
  });

  it('refreshes the session and reconnects immediately when the token expired (4401 / reauth)', async () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().emit({ type: 'reauth' });
    t.last().drop(4401);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(t.refresh).toHaveBeenCalledTimes(1);
    expect(t.timers).toHaveLength(0);
  });

  it('stops for good when the session cannot be refreshed (signed out)', async () => {
    const t = setup(vi.fn(async () => false));
    t.client.start();
    t.last().drop(4401);
    await vi.waitFor(() => expect(t.client.currentStatus).toBe('closed'));
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('stop() closes the socket and cancels reconnects (connection cleanup)', () => {
    const t = setup();
    t.client.start();
    const s = t.last();
    s.open();
    t.client.stop();
    expect(s.closed).toBe(1000);
    s.drop();
    expect(t.timers).toHaveLength(0);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('nudge() reconnects at once when offline, and does nothing when connected', () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.client.nudge();
    expect(FakeSocket.instances).toHaveLength(1);
    t.last().drop();
    t.client.nudge();
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('caps the backoff at 30 s', () => {
    expect(backoffDelay(20, () => 1)).toBe(30_000);
    expect(backoffDelay(0, () => 0)).toBe(500);
  });
});

describe('resolveRealtimeUrl', () => {
  it('uses the same origin by default, wss on https', () => {
    expect(resolveRealtimeUrl(undefined, { protocol: 'https:', host: 'tasks.example.com' })).toBe('wss://tasks.example.com/api/v1/realtime');
    expect(resolveRealtimeUrl(undefined, { protocol: 'http:', host: 'localhost:3001' })).toBe('ws://localhost:3001/api/v1/realtime');
    expect(resolveRealtimeUrl('ws://localhost:3000/api/v1/realtime', { protocol: 'http:', host: 'localhost:3001' })).toBe('ws://localhost:3000/api/v1/realtime');
  });
});
