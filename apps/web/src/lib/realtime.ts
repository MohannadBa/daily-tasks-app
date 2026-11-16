import type { RealtimeEvent, RealtimeServerMessage } from '@dailytasks/shared-types';

export type RealtimeStatus = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RealtimeClientOptions {
  url: string;
  onEvent: (event: RealtimeEvent) => void;
  onStatus?: (status: RealtimeStatus) => void;
  /** Refreshes the session cookie (e.g. GET /bff/auth/me); resolves false if signed out. */
  refreshSession: () => Promise<boolean>;
  /** Injectable for tests. */
  WebSocketImpl?: typeof WebSocket;
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const MIN_DELAY = 1000;
const MAX_DELAY = 30_000;

/** Exponential backoff with full jitter: attempt 0 → ~1s, capped at 30s. */
export function backoffDelay(attempt: number, random = Math.random): number {
  const cap = Math.min(MAX_DELAY, MIN_DELAY * 2 ** attempt);
  return Math.round(MIN_DELAY / 2 + random() * (cap - MIN_DELAY / 2));
}

/**
 * WebSocket client for live updates. Reconnects with backoff, refreshes the session when the
 * server reports an expired token (close 4401 / "reauth"), and stops after sign-out.
 */
export class RealtimeClient {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: unknown = null;
  private stopped = false;
  private status: RealtimeStatus = 'closed';
  private readonly WS: typeof WebSocket;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly opts: RealtimeClientOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  get currentStatus() {
    return this.status;
  }

  private setStatus(s: RealtimeStatus) {
    if (s === this.status) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= 1) ws.close(1000, 'client stop');
    this.setStatus('closed');
  }

  /** Reconnect now if disconnected (network back online, tab visible again). */
  nudge() {
    if (this.stopped || (this.ws && this.ws.readyState <= 1)) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    this.connect();
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let ws: WebSocket;
    try {
      ws = new this.WS(this.opts.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    let reauth = false;
    ws.onmessage = (e: MessageEvent) => {
      let msg: RealtimeServerMessage;
      try {
        msg = JSON.parse(String(e.data)) as RealtimeServerMessage;
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        this.attempt = 0;
        this.setStatus('open');
      } else if (msg.type === 'event') {
        this.opts.onEvent(msg.event);
      } else if (msg.type === 'reauth') {
        reauth = true;
      }
    };
    ws.onclose = (e: CloseEvent) => {
      if (this.ws !== ws) return; // superseded
      this.ws = null;
      if (this.stopped) return;
      if (reauth || e.code === 4401 || e.code === 1008) void this.reauthenticate();
      else this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose follows */
    };
  }

  private async reauthenticate() {
    const ok = await this.opts.refreshSession().catch(() => false);
    if (!ok) {
      this.stop();
      return;
    }
    this.attempt = 0;
    this.connect();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    // The handshake is rejected with 401 when the cookie expired; try a session refresh every few attempts.
    const delay = backoffDelay(this.attempt, this.opts.random);
    this.attempt++;
    this.setStatus('reconnecting');
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (this.attempt % 3 === 0) void this.reauthenticate();
      else this.connect();
    }, delay);
  }
}

/** ws(s)://<origin>/api/v1/realtime unless an explicit URL is configured (local dev: API on another port). */
export function resolveRealtimeUrl(configured: string | undefined, location: Pick<Location, 'protocol' | 'host'>, path = '/api/v1/realtime'): string {
  if (configured) return configured;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;
}
