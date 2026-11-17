import { Inject, Injectable, Logger, Module, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import jwt from 'jsonwebtoken';
import { Client as PgClient } from 'pg';
import { WebSocket, WebSocketServer } from 'ws';
import type { ApiEnv } from '@dailytasks/config';
import { REALTIME_CHANNEL, REALTIME_PATH, type RealtimeEnvelope, type RealtimeServerMessage } from '@dailytasks/shared-types';
import { AuthModule } from '../auth/auth.module';
import { AccessGate } from '../auth/access-gate';
import { TokenService } from '../auth/token.service';
import { API_ENV } from '../config/config.module';
import { PrismaService } from '../prisma/prisma.service';

export const ACCESS_COOKIE = 'dt_access';
const HEARTBEAT_MS = 25_000; // below the ALB idle timeout (60 s)
const MAX_SOCKETS_PER_USER = 10;

interface Session {
  ws: WebSocket;
  userId: string;
  alive: boolean;
  expiryTimer?: NodeJS.Timeout;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** pg needs a plain connection string; Prisma-only params are removed and TLS matches Prisma's `sslmode=require`. */
export function pgConfigFromDatabaseUrl(url: string) {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode');
  for (const k of ['schema', 'connection_limit', 'sslmode', 'pool_timeout', 'pgbouncer']) u.searchParams.delete(k);
  return { connectionString: u.toString(), ssl: sslmode && sslmode !== 'disable' ? { rejectUnauthorized: false } : undefined };
}

/**
 * Real-time updates for open sessions over WebSocket (`/api/v1/realtime`).
 *  - Auth: the httpOnly `dt_access` session cookie (sent by the browser on the upgrade) or a
 *    Bearer header; the user row is re-checked (active). The socket is closed when the token
 *    expires; the client refreshes its session and reconnects.
 *  - Origin must be one of CORS_ORIGINS (blocks cross-site WebSocket hijacking).
 *  - Fan-out across API instances: the worker publishes `pg_notify('dt_realtime', envelope)`;
 *    every instance LISTENs and forwards to that user's sockets only.
 *  - Events carry ids only; clients refetch through the authorized REST API.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  private readonly sessions = new Map<string, Set<Session>>();
  private listener?: PgClient;
  private heartbeat?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = false;
  private readonly origins: string[];

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly gate: AccessGate,
  ) {
    this.origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  }

  async onApplicationBootstrap() {
    const server = this.adapterHost.httpAdapter?.getHttpServer() as Server | undefined;
    server?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const path = (req.url ?? '').split('?')[0];
      if (path !== REALTIME_PATH) {
        // Not ours. If nothing else handles upgrades, answer 404 instead of leaving the socket hanging.
        if (server.listenerCount('upgrade') === 1) this.reject(socket, 404, 'Not Found');
        return;
      }
      void this.handleUpgrade(req, socket, head);
    });
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    await this.listen();
  }

  async onModuleDestroy() {
    this.stopped = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.reconnectTimer);
    for (const set of this.sessions.values()) for (const s of set) s.ws.close(1001, 'server shutting down');
    this.wss.close();
    await this.listener?.end().catch(() => undefined);
  }

  /** Number of open sockets (health/metrics and tests). */
  get connectionCount() {
    let n = 0;
    for (const set of this.sessions.values()) n += set.size;
    return n;
  }

  private reject(socket: Duplex, status: number, message: string) {
    socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients (no ambient credentials to abuse)
    if (this.origins.includes(origin)) return true;
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    try {
      return new URL(origin).host === host; // same origin (behind the ALB)
    } catch {
      return false;
    }
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (!this.originAllowed(req)) return this.reject(socket, 403, 'Forbidden');
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7).trim() : undefined;
    const token = bearer ?? parseCookies(req.headers.cookie)[ACCESS_COOKIE];
    if (!token) return this.reject(socket, 401, 'Unauthorized');
    let userId: string;
    let expMs: number | undefined;
    try {
      const verified = await this.tokens.verifyAccessToken(token);
      const user = await this.prisma.user.findUnique({ where: verified.mode === 'local' ? { id: verified.subject } : { cognitoSub: verified.subject } });
      if (!user?.isActive || !this.gate.allows(user.email)) return this.reject(socket, 401, 'Unauthorized');
      userId = user.id;
      const exp = (jwt.decode(token) as { exp?: number } | null)?.exp;
      expMs = exp ? exp * 1000 : undefined;
    } catch {
      return this.reject(socket, 401, 'Unauthorized');
    }
    if ((this.sessions.get(userId)?.size ?? 0) >= MAX_SOCKETS_PER_USER) return this.reject(socket, 429, 'Too Many Requests');

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const session: Session = { ws, userId, alive: true };
      const set = this.sessions.get(userId) ?? new Set<Session>();
      set.add(session);
      this.sessions.set(userId, set);
      if (expMs) {
        const ms = Math.max(0, Math.min(expMs - Date.now(), 2 ** 31 - 1));
        session.expiryTimer = setTimeout(() => {
          this.send(ws, { type: 'reauth' });
          ws.close(4401, 'token expired');
        }, ms);
      }
      ws.on('pong', () => (session.alive = true));
      ws.on('message', () => undefined); // clients do not send commands; ignore anything received
      ws.on('close', () => this.drop(session));
      ws.on('error', () => this.drop(session));
      this.send(ws, { type: 'hello', userId, heartbeatMs: HEARTBEAT_MS });
    });
  }

  private drop(session: Session) {
    clearTimeout(session.expiryTimer);
    const set = this.sessions.get(session.userId);
    if (!set) return;
    set.delete(session);
    if (set.size === 0) this.sessions.delete(session.userId);
  }

  /** Ping every socket; terminate the ones that did not answer the previous ping. */
  private sweep() {
    for (const set of this.sessions.values()) {
      for (const s of set) {
        if (!s.alive) {
          s.ws.terminate();
          this.drop(s);
          continue;
        }
        s.alive = false;
        s.ws.ping();
      }
    }
  }

  private send(ws: WebSocket, msg: RealtimeServerMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  /** Delivers an envelope to the listed users' sockets on this instance. */
  deliver(envelope: RealtimeEnvelope) {
    for (const userId of envelope.users) {
      for (const s of this.sessions.get(userId) ?? []) this.send(s.ws, { type: 'event', event: envelope.event });
    }
  }

  private async listen() {
    if (this.stopped) return;
    const url = process.env.DATABASE_URL;
    if (!url) return;
    const client = new PgClient(pgConfigFromDatabaseUrl(url));
    client.on('notification', (msg) => {
      if (msg.channel !== REALTIME_CHANNEL || !msg.payload) return;
      try {
        const envelope = JSON.parse(msg.payload) as RealtimeEnvelope;
        if (Array.isArray(envelope.users) && envelope.event) this.deliver(envelope);
      } catch {
        this.logger.warn('ignored malformed realtime payload');
      }
    });
    const retry = (why: string) => {
      if (this.stopped) return;
      this.logger.warn(`realtime listener lost (${why}); reconnecting`);
      client.removeAllListeners();
      void client.end().catch(() => undefined);
      this.listener = undefined;
      this.reconnectTimer = setTimeout(() => void this.listen(), 2000);
    };
    client.on('error', (e) => retry(e.message));
    client.on('end', () => retry('connection ended'));
    try {
      await client.connect();
      await client.query(`LISTEN ${REALTIME_CHANNEL}`);
      this.listener = client;
    } catch (e) {
      retry((e as Error).message);
    }
  }
}

@Module({ imports: [AuthModule], providers: [RealtimeService], exports: [RealtimeService] })
export class RealtimeModule {}
