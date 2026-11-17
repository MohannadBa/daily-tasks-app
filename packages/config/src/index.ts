import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Product constants shared by every app                              */
/* ------------------------------------------------------------------ */

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const ATTACHMENT_MAX_PER_REQUEST = 10;

/** Allow-list of MIME types -> permitted file extensions. */
/**
 * Types that may be served inline (rendered in the browser) for in-app previews. Never HTML/SVG/text:
 * those are always downloaded, so a stored file can never execute in a browsing context.
 */
export const INLINE_PREVIEW_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
/** Image types the web app shows as thumbnails (HEIC/HEIF are not renderable in most browsers). */
export const IMAGE_PREVIEW_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

export const ALLOWED_ATTACHMENT_TYPES: Record<string, string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/heic': ['heic'],
  'image/heif': ['heif'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt'],
  'text/csv': ['csv'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
};

/* ------------------------------ Web Push ------------------------------ */

/**
 * Hosts of the browser push services we deliver to (suffix match). The worker POSTs to the
 * subscription endpoint, so anything else is rejected to prevent SSRF via forged subscriptions.
 *   Chrome/Edge(Android)/Samsung: fcm.googleapis.com · Safari/iOS: web.push.apple.com
 *   Firefox: *.push.services.mozilla.com · Edge (Windows): *.notify.windows.com
 */
export const DEFAULT_PUSH_ENDPOINT_HOSTS = ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];
/** Max delivery attempts per (notification, subscription) before it is marked FAILED. */
export const PUSH_MAX_ATTEMPTS = 5;
/** How long push services keep an undelivered message (device offline). Reminders are stale after this. */
export const PUSH_TTL_SECONDS = 24 * 3600;
/** Consecutive failed deliveries after which a subscription is deactivated. */
export const PUSH_MAX_CONSECUTIVE_FAILURES = 20;
/** Local-development personal-data key from docker-compose.yml / tests. Refused in production. */
export const DEV_PERSONAL_DATA_KEY = 'local-development-only-personal-data-key-0123456789';
/** Report PDFs and datasets are kept this long. */
export const REPORT_RETENTION_DAYS = 7;
/** Report jobs per user per hour. */
export const REPORT_JOBS_PER_HOUR = 20;
/** Maximum tasks in one employee report. */
export const REPORT_MAX_TASKS = 2000;
/** Maximum transfer chain depth per cycle. */
export const MAX_TRANSFER_DEPTH = 3;

/** Local-development VAPID public key from docker-compose.yml. Refused in production. */
export const DEV_VAPID_PUBLIC_KEY = 'BMW1eav9vRcXwjakWQGhbeHneaQ6NiDCI-GNmK_LI3EcGGlxknRwdVxgjOvKKQSXcZDOZb9QN5g56IgICPtAT5o';

/** Parses a comma-separated host list, falling back to the defaults. */
export function parsePushHosts(value: string | undefined): string[] {
  const hosts = (value ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  return hosts.length ? hosts : DEFAULT_PUSH_ENDPOINT_HOSTS;
}

/**
 * True when `endpoint` points at an allowed push service. HTTPS is required unless
 * `allowInsecure` (local fake push service in tests only).
 */
export function isAllowedPushEndpoint(endpoint: string, hosts: string[], allowInsecure = false): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:' && !(allowInsecure && url.protocol === 'http:')) return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

export const DEFAULT_REMINDER_OFFSETS_MINUTES = [24 * 60, 60];
export const MAX_REMINDER_OFFSETS = 5;
export const MAX_REMINDER_OFFSET_MINUTES = 14 * 24 * 60;

export const PRESIGNED_UPLOAD_TTL_SECONDS = 10 * 60;
export const PRESIGNED_DOWNLOAD_TTL_SECONDS = 5 * 60;

/* ------------------------------------------------------------------ */
/* Environment validation                                             */
/* ------------------------------------------------------------------ */

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const commonEnv = {
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DATABASE_URL: z.string().url(),
  AWS_REGION: z.string().default('us-east-1'),
  /** Optional endpoint override for LocalStack (e.g. http://localstack:4566). Empty in AWS. */
  AWS_ENDPOINT_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  S3_BUCKET: z.string().min(1),
  /** Endpoint used when generating pre-signed URLs that clients (browser/phone) will call. */
  S3_PUBLIC_ENDPOINT: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  S3_FORCE_PATH_STYLE: bool.default(false),
  SQS_EVENTS_QUEUE_URL: z.string().url(),
};

export const apiEnvSchema = z
  .object({
    ...commonEnv,
    PORT: z.coerce.number().int().positive().default(3000),
    CORS_ORIGINS: z.string().default(''),
    /** Trusted proxies in front of the API: 1 = ALB (custom domain), 2 = CloudFront → ALB. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(3).default(1),
    AUTH_MODE: z.enum(['local', 'cognito']).default('local'),
    /** Required in local auth mode. Must be long and random. */
    JWT_SECRET: z.string().optional(),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),
    COGNITO_USER_POOL_ID: z.string().optional(),
    COGNITO_CLIENT_ID: z.string().optional(),
    SWAGGER_ENABLED: bool.default(true),
    /** VAPID public key (base64url). Public by design; sent to browsers to subscribe. Empty = push disabled. */
    WEB_PUSH_VAPID_PUBLIC_KEY: z.string().default(''),
    /** Comma-separated push service hosts (suffix match). Defaults to the major browser push services. */
    WEB_PUSH_ALLOWED_HOSTS: z.string().optional(),
    /** Accept http:// endpoints (local fake push service in tests). Refused in production. */
    WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: bool.default(false),
    /**
     * Secret for encrypting personal tasks at rest (AES-256-GCM, key = SHA-256 of this value).
     * Secrets Manager in AWS. Losing it makes existing personal tasks unreadable.
     */
    PERSONAL_DATA_KEY: z.string().default(''),
    /** Previous key, set only during a key rotation (decrypt fallback; see docs/OPERATIONS.md). */
    PERSONAL_DATA_KEY_PREVIOUS: z.string().default(''),
    /**
     * Launch gate. `restricted` (acceptance testing): only the e-mail addresses in ACCESS_ALLOWLIST can
     * sign in, refresh, call the API, open the live-update socket or be provisioned. `open`: normal operation.
     */
    ACCESS_MODE: z.enum(['open', 'restricted']).default('open'),
    /** Comma-separated e-mail addresses (case-insensitive). Required when ACCESS_MODE=restricted. */
    ACCESS_ALLOWLIST: z.string().default(''),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === 'local') {
      if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
        ctx.addIssue({ code: 'custom', path: ['JWT_SECRET'], message: 'JWT_SECRET (>=32 chars) is required when AUTH_MODE=local' });
      }
      if (env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_AUTH_IN_PRODUCTION !== 'true') {
        ctx.addIssue({ code: 'custom', path: ['AUTH_MODE'], message: 'AUTH_MODE=local is not allowed in production' });
      }
    }
    if (env.NODE_ENV === 'production') {
      pushProductionChecks(env, ctx);
      if (env.PERSONAL_DATA_KEY.length < 32 || env.PERSONAL_DATA_KEY === DEV_PERSONAL_DATA_KEY) {
        ctx.addIssue({ code: 'custom', path: ['PERSONAL_DATA_KEY'], message: 'PERSONAL_DATA_KEY (>=32 chars, not the development value) is required in production' });
      }
    }
    if (env.PERSONAL_DATA_KEY_PREVIOUS && (env.PERSONAL_DATA_KEY_PREVIOUS.length < 32 || env.PERSONAL_DATA_KEY_PREVIOUS === env.PERSONAL_DATA_KEY)) {
      ctx.addIssue({ code: 'custom', path: ['PERSONAL_DATA_KEY_PREVIOUS'], message: 'PERSONAL_DATA_KEY_PREVIOUS must be >= 32 characters and differ from PERSONAL_DATA_KEY' });
    }
    if (env.NODE_ENV !== 'production' && env.PERSONAL_DATA_KEY.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['PERSONAL_DATA_KEY'], message: 'PERSONAL_DATA_KEY (>=32 chars) is required' });
    }
    if (env.ACCESS_MODE === 'restricted') {
      const entries = env.ACCESS_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
      if (entries.length === 0) ctx.addIssue({ code: 'custom', path: ['ACCESS_ALLOWLIST'], message: 'ACCESS_ALLOWLIST must list at least one e-mail address when ACCESS_MODE=restricted' });
      else if (entries.some((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e))) ctx.addIssue({ code: 'custom', path: ['ACCESS_ALLOWLIST'], message: 'ACCESS_ALLOWLIST contains an entry that is not an e-mail address' });
    }
    if (env.AUTH_MODE === 'cognito' && (!env.COGNITO_USER_POOL_ID || !env.COGNITO_CLIENT_ID)) {
      ctx.addIssue({ code: 'custom', path: ['COGNITO_USER_POOL_ID'], message: 'Cognito settings are required when AUTH_MODE=cognito' });
    }
  });
export type ApiEnv = z.infer<typeof apiEnvSchema>;

export const workerEnvSchema = z.object({
  ...commonEnv,
  HEALTH_PORT: z.coerce.number().int().positive().default(3002),
  /** "local" stores deadline jobs in Postgres; "eventbridge" uses EventBridge Scheduler. */
  SCHEDULER_MODE: z.enum(['local', 'eventbridge']).default('local'),
  SCHEDULER_GROUP_NAME: z.string().default('default'),
  SCHEDULER_TARGET_QUEUE_ARN: z.string().optional(),
  SCHEDULER_ROLE_ARN: z.string().optional(),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  LOCAL_SCHEDULER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  /** Master switch. When false (or VAPID keys are missing) notifications are stored but not pushed. */
  PUSH_ENABLED: bool.default(true),
  /** VAPID key pair (base64url). The private key comes from Secrets Manager in AWS; never stored in the DB. */
  WEB_PUSH_VAPID_PUBLIC_KEY: z.string().default(''),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.string().default(''),
  /** VAPID "sub" claim: mailto: or https: contact for push services. */
  WEB_PUSH_SUBJECT: z.string().default('mailto:admin@dailytasks.local'),
  WEB_PUSH_ALLOWED_HOSTS: z.string().optional(),
  WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: bool.default(false),
  WEB_PUSH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Push requests sent in parallel. */
  WEB_PUSH_CONCURRENCY: z.coerce.number().int().positive().max(100).default(10),
  /** PDF reports: headless Chromium executable (Debian package in the worker image). */
  REPORTS_ENABLED: bool.default(true),
  CHROMIUM_PATH: z.string().optional(),
  REPORT_RENDER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production') pushProductionChecks(env, ctx);
  if (env.PUSH_ENABLED && env.WEB_PUSH_VAPID_PUBLIC_KEY && !env.WEB_PUSH_VAPID_PRIVATE_KEY) {
    ctx.addIssue({ code: 'custom', path: ['WEB_PUSH_VAPID_PRIVATE_KEY'], message: 'WEB_PUSH_VAPID_PRIVATE_KEY is required when a public key is set' });
  }
  if (!/^(mailto:|https:\/\/)/.test(env.WEB_PUSH_SUBJECT)) {
    ctx.addIssue({ code: 'custom', path: ['WEB_PUSH_SUBJECT'], message: 'WEB_PUSH_SUBJECT must start with mailto: or https://' });
  }
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

function pushProductionChecks(env: { WEB_PUSH_VAPID_PUBLIC_KEY: string; WEB_PUSH_ALLOW_INSECURE_ENDPOINTS: boolean }, ctx: z.RefinementCtx) {
  if (env.WEB_PUSH_VAPID_PUBLIC_KEY === DEV_VAPID_PUBLIC_KEY) {
    ctx.addIssue({ code: 'custom', path: ['WEB_PUSH_VAPID_PUBLIC_KEY'], message: 'The local development VAPID key must not be used in production' });
  }
  if (env.WEB_PUSH_ALLOW_INSECURE_ENDPOINTS) {
    ctx.addIssue({ code: 'custom', path: ['WEB_PUSH_ALLOW_INSECURE_ENDPOINTS'], message: 'Insecure push endpoints are not allowed in production' });
  }
}

/**
 * On ECS the RDS secret is injected as separate DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_NAME
 * variables. Prisma needs a single URL, so build DATABASE_URL from them when it is not set.
 * TLS is required for RDS connections.
 */
export function ensureDatabaseUrl(env: Record<string, string | undefined> = process.env): void {
  if (env.DATABASE_URL || !env.DB_HOST) return;
  const user = encodeURIComponent(env.DB_USERNAME ?? '');
  const pass = encodeURIComponent(env.DB_PASSWORD ?? '');
  // Restore drills only: point a one-off task at a restored RDS instance (same credentials) without
  // touching the secret. Restricted to RDS endpoints; the certificate is still verified.
  const override = env.DB_HOST_OVERRIDE?.trim();
  if (override && !/^[a-z0-9.-]+\.rds\.amazonaws\.com$/i.test(override)) throw new Error('DB_HOST_OVERRIDE must be an RDS endpoint (*.rds.amazonaws.com)');
  const host = override || env.DB_HOST;
  const ssl = env.DB_SSLMODE ?? 'require';
  // With DB_SSL_CA_FILE (the RDS CA bundle shipped in the images) the server certificate and host
  // name are verified (Prisma sslaccept=strict). Without it, TLS is used but not verified.
  const verify = env.DB_SSL_CA_FILE ? `&sslcert=${encodeURIComponent(env.DB_SSL_CA_FILE)}&sslaccept=strict` : '';
  env.DATABASE_URL = `postgresql://${user}:${pass}@${host}:${env.DB_PORT ?? '5432'}/${env.DB_NAME ?? 'dailytasks'}?schema=public&sslmode=${ssl}${verify}&connection_limit=${env.DB_CONNECTION_LIMIT ?? '10'}`;
}

/** Parse env and fail fast with a readable error that never prints secret values. */
/**
 * Accepted alternative names (common in Web Push guides). The canonical WEB_PUSH_* name wins
 * when both are set. NEXT_PUBLIC_VAPID_PUBLIC_KEY is deliberately NOT used: the browser fetches
 * the public key at runtime from GET /api/v1/push/vapid-public-key, so one web image works in
 * every environment and keys can rotate without rebuilding.
 */
export const ENV_ALIASES: Record<string, string> = {
  VAPID_PUBLIC_KEY: 'WEB_PUSH_VAPID_PUBLIC_KEY',
  VAPID_PRIVATE_KEY: 'WEB_PUSH_VAPID_PRIVATE_KEY',
  VAPID_SUBJECT: 'WEB_PUSH_SUBJECT',
};

export function applyEnvAliases(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...source };
  for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
    if (!out[canonical] && out[alias]) out[canonical] = out[alias];
  }
  return out;
}

export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: Record<string, string | undefined> = process.env): z.infer<T> {
  const result = schema.safeParse(applyEnvAliases(source));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
