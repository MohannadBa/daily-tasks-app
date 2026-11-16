import { z } from 'zod';

/* ------------------------------------------------------------------ */
/* Product constants shared by every app                              */
/* ------------------------------------------------------------------ */

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB per file
export const ATTACHMENT_MAX_PER_REQUEST = 10;

/** Allow-list of MIME types -> permitted file extensions. */
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
    AUTH_MODE: z.enum(['local', 'cognito']).default('local'),
    /** Required in local auth mode. Must be long and random. */
    JWT_SECRET: z.string().optional(),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(30 * 24 * 3600),
    COGNITO_USER_POOL_ID: z.string().optional(),
    COGNITO_CLIENT_ID: z.string().optional(),
    SWAGGER_ENABLED: bool.default(true),
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
  PUSH_RECEIPT_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  /** Optional Expo access token (enhanced push security). */
  EXPO_ACCESS_TOKEN: z.string().optional(),
  PUSH_ENABLED: bool.default(true),
});
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * On ECS the RDS secret is injected as separate DB_HOST/DB_PORT/DB_USERNAME/DB_PASSWORD/DB_NAME
 * variables. Prisma needs a single URL, so build DATABASE_URL from them when it is not set.
 * TLS is required for RDS connections.
 */
export function ensureDatabaseUrl(env: Record<string, string | undefined> = process.env): void {
  if (env.DATABASE_URL || !env.DB_HOST) return;
  const user = encodeURIComponent(env.DB_USERNAME ?? '');
  const pass = encodeURIComponent(env.DB_PASSWORD ?? '');
  const ssl = env.DB_SSLMODE ?? 'require';
  env.DATABASE_URL = `postgresql://${user}:${pass}@${env.DB_HOST}:${env.DB_PORT ?? '5432'}/${env.DB_NAME ?? 'dailytasks'}?schema=public&sslmode=${ssl}&connection_limit=${env.DB_CONNECTION_LIMIT ?? '10'}`;
}

/** Parse env and fail fast with a readable error that never prints secret values. */
export function loadEnv<T extends z.ZodTypeAny>(schema: T, source: Record<string, string | undefined> = process.env): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return result.data;
}
