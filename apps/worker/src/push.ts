import webpush from 'web-push';
import { isAllowedPushEndpoint, PUSH_TTL_SECONDS } from '@dailytasks/config';
import type { PushPayload } from '@dailytasks/shared-types';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushOptions {
  /** RFC 8030 urgency: "high" wakes the device even in power-saving modes. */
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  /** RFC 8030 topic (≤ 32 base64url chars): a newer message with the same topic replaces an undelivered one. */
  topic?: string;
  ttlSeconds?: number;
}

export type PushOutcome =
  /** Push service accepted the message (2xx). NOT proof that the device displayed it. */
  | 'sent'
  /** 404/410: the subscription no longer exists. Deactivate it. */
  | 'expired'
  /** Will not succeed on retry (400 malformed, 403 key mismatch, 413 too large, endpoint not allowed). */
  | 'failed'
  /** 429, 5xx, network error or timeout: retry later. */
  | 'transient';

export interface PushResult {
  outcome: PushOutcome;
  statusCode: number | null;
  error?: string;
}

export interface PushTransport {
  /** False when push is switched off or VAPID keys are missing; notifications are still stored. */
  readonly enabled: boolean;
  send(target: PushTarget, payload: PushPayload, options: PushOptions): Promise<PushResult>;
}

export function classifyStatus(status: number): PushOutcome {
  if (status >= 200 && status < 300) return 'sent';
  if (status === 404 || status === 410) return 'expired';
  if (status === 429 || status >= 500) return 'transient';
  return 'failed';
}

export interface WebPushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
  allowedHosts: string[];
  allowInsecure: boolean;
  timeoutMs: number;
}

/**
 * Web Push (RFC 8030/8291/8292). `web-push` builds the VAPID JWT and the aes128gcm-encrypted body;
 * the request itself is sent with fetch so we control timeouts and status handling.
 * Push services (FCM, Apple, Mozilla, WNS) decide when the device receives it; there is no
 * delivery-time guarantee.
 */
export class WebPushTransport implements PushTransport {
  readonly enabled = true;
  constructor(
    private readonly cfg: WebPushConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(target: PushTarget, payload: PushPayload, options: PushOptions): Promise<PushResult> {
    // Defence in depth: the API validates on subscribe, but never POST to arbitrary hosts (SSRF).
    if (!isAllowedPushEndpoint(target.endpoint, this.cfg.allowedHosts, this.cfg.allowInsecure)) {
      return { outcome: 'failed', statusCode: null, error: 'endpoint host not allowed' };
    }
    let details: ReturnType<typeof webpush.generateRequestDetails>;
    try {
      details = webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(payload), {
        vapidDetails: { subject: this.cfg.subject, publicKey: this.cfg.publicKey, privateKey: this.cfg.privateKey },
        TTL: options.ttlSeconds ?? PUSH_TTL_SECONDS,
        urgency: options.urgency,
        topic: options.topic,
        contentEncoding: 'aes128gcm',
      });
    } catch (e) {
      // Invalid client keys or payload too large for encryption.
      return { outcome: 'failed', statusCode: null, error: `encrypt: ${(e as Error).message}`.slice(0, 300) };
    }
    try {
      const res = await this.fetchImpl(details.endpoint, {
        method: details.method,
        headers: details.headers as Record<string, string>,
        body: details.body ? new Uint8Array(details.body as Buffer) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: 'error',
      });
      const outcome = classifyStatus(res.status);
      const error = outcome === 'sent' ? undefined : (await res.text().catch(() => '')).slice(0, 300) || res.statusText;
      return { outcome, statusCode: res.status, error };
    } catch (e) {
      const err = e as Error;
      return { outcome: 'transient', statusCode: null, error: (err.name === 'TimeoutError' ? 'timeout' : err.message).slice(0, 300) };
    }
  }
}

/** PUSH_ENABLED=false / no VAPID keys. */
export class DisabledPushTransport implements PushTransport {
  readonly enabled = false;
  async send(): Promise<PushResult> {
    return { outcome: 'failed', statusCode: null, error: 'push disabled' };
  }
}

/** Test double: records every send; scripted outcomes per endpoint (default "sent"/201). */
export class RecordingPushTransport implements PushTransport {
  readonly enabled = true;
  sent: Array<{ target: PushTarget; payload: PushPayload; options: PushOptions }> = [];
  private readonly scripted = new Map<string, PushResult[]>();

  /** Queue results for an endpoint; the last one repeats. */
  script(endpoint: string, ...results: PushResult[]) {
    this.scripted.set(endpoint, results);
  }

  async send(target: PushTarget, payload: PushPayload, options: PushOptions): Promise<PushResult> {
    this.sent.push({ target, payload, options });
    const queue = this.scripted.get(target.endpoint);
    if (!queue?.length) return { outcome: 'sent', statusCode: 201 };
    return queue.length > 1 ? queue.shift()! : queue[0]!;
  }
}
