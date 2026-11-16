import { createServer, type Server } from 'node:http';
import { ensureDatabaseUrl, loadEnv, parsePushHosts, workerEnvSchema, type WorkerEnv } from '@dailytasks/config';
import { PrismaClient } from '@dailytasks/database';
import { errMsg, logger, setLogLevel } from './logger';
import { cleanupAbandonedUploads, S3ObjectStore } from './attachments';
import { Notifier, pushMaintenance, RetryableDeliveryError } from './notifier';
import { OutboxRelay } from './outbox-relay';
import { EventProcessor } from './processor';
import { DisabledPushTransport, WebPushTransport, type PushTransport } from './push';
import { SqsQueue, type Queue } from './queue';
import { EventBridgeDeadlineScheduler, LocalDbScheduler, type DeadlineScheduler } from './scheduler';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Runs `fn` repeatedly until shutdown; errors are logged and retried after `intervalMs`. */
async function loop(name: string, intervalMs: number, signal: AbortSignal, fn: () => Promise<number | void>) {
  while (!signal.aborted) {
    try {
      const n = await fn();
      // Keep draining while there is work; otherwise wait.
      if (typeof n === 'number' && n > 0) continue;
    } catch (e) {
      logger.error(`${name} iteration failed`, { error: errMsg(e) });
    }
    await sleep(intervalMs, signal);
  }
  logger.info(`${name} stopped`);
}

export function buildWorker(env: WorkerEnv, prisma: PrismaClient) {
  const queue: Queue = new SqsQueue(env.SQS_EVENTS_QUEUE_URL, env.AWS_REGION, env.AWS_ENDPOINT_URL);
  const push: PushTransport =
    env.PUSH_ENABLED && env.WEB_PUSH_VAPID_PUBLIC_KEY && env.WEB_PUSH_VAPID_PRIVATE_KEY
      ? new WebPushTransport({
          publicKey: env.WEB_PUSH_VAPID_PUBLIC_KEY,
          privateKey: env.WEB_PUSH_VAPID_PRIVATE_KEY,
          subject: env.WEB_PUSH_SUBJECT,
          allowedHosts: parsePushHosts(env.WEB_PUSH_ALLOWED_HOSTS),
          allowInsecure: env.WEB_PUSH_ALLOW_INSECURE_ENDPOINTS,
          timeoutMs: env.WEB_PUSH_TIMEOUT_MS,
        })
      : new DisabledPushTransport();
  const local = env.SCHEDULER_MODE === 'local' ? new LocalDbScheduler(prisma, queue) : null;
  const scheduler: DeadlineScheduler =
    local ??
    new EventBridgeDeadlineScheduler(
      {
        region: env.AWS_REGION,
        groupName: env.SCHEDULER_GROUP_NAME,
        targetQueueArn: env.SCHEDULER_TARGET_QUEUE_ARN!,
        roleArn: env.SCHEDULER_ROLE_ARN!,
      },
      queue,
    );
  const processor = new EventProcessor(prisma, new Notifier(prisma, push, env.WEB_PUSH_CONCURRENCY), scheduler);
  const relay = new OutboxRelay(prisma, queue);
  return { queue, push, local, processor, relay };
}

async function main() {
  ensureDatabaseUrl();
  const env = loadEnv(workerEnvSchema);
  setLogLevel(env.LOG_LEVEL);
  if (env.SCHEDULER_MODE === 'eventbridge' && (!env.SCHEDULER_TARGET_QUEUE_ARN || !env.SCHEDULER_ROLE_ARN)) {
    throw new Error('SCHEDULER_TARGET_QUEUE_ARN and SCHEDULER_ROLE_ARN are required when SCHEDULER_MODE=eventbridge');
  }
  const prisma = new PrismaClient();
  await prisma.$connect();
  const { queue, push, local, processor, relay } = buildWorker(env, prisma);

  const controller = new AbortController();
  const { signal } = controller;
  let lastConsumerTick = Date.now();

  const consumer = async () => {
    lastConsumerTick = Date.now();
    const messages = await queue.receive(10, 20);
    lastConsumerTick = Date.now();
    await Promise.all(
      messages.map(async (m) => {
        try {
          await processor.handle(m.body);
          await queue.ack(m.receiptHandle);
        } catch (e) {
          // Not acked: SQS redelivers after the visibility timeout; after maxReceiveCount it goes to the DLQ.
          const log = e instanceof RetryableDeliveryError ? logger.warn : logger.error;
          log('message processing failed', { type: m.body.type, dedupeKey: m.body.dedupeKey, receiveCount: m.receiveCount, error: errMsg(e) });
        }
      }),
    );
    return messages.length;
  };

  const loops = [
    loop('outbox-relay', env.OUTBOX_POLL_INTERVAL_MS, signal, () => relay.relayBatch()),
    loop('consumer', 1000, signal, consumer),
    loop('push-maintenance', 6 * 3600_000, signal, () => pushMaintenance(prisma)),
    loop('attachment-cleanup', 3600_000, signal, () => cleanupAbandonedUploads(prisma, new S3ObjectStore(env.S3_BUCKET, env.AWS_REGION, env.AWS_ENDPOINT_URL, env.S3_FORCE_PATH_STYLE)).then(() => undefined)),
    loop('outbox-cleanup', 6 * 3600_000, signal, () => relay.cleanup()),
  ];
  if (local) loops.push(loop('local-scheduler', env.LOCAL_SCHEDULER_POLL_INTERVAL_MS, signal, () => local.fireDue()));

  const server: Server = createServer(async (req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    try {
      await prisma.$queryRaw`SELECT 1`;
      // Consumer long-polls for 20s; anything over 2 minutes means it is stuck.
      const healthy = Date.now() - lastConsumerTick < 120_000;
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' }).end(JSON.stringify({ status: healthy ? 'ok' : 'stalled' }));
    } catch {
      res.writeHead(503).end(JSON.stringify({ status: 'db-down' }));
    }
  });
  server.listen(env.HEALTH_PORT, '0.0.0.0');
  logger.info('worker started', { scheduler: env.SCHEDULER_MODE, push: push.enabled ? 'web-push' : 'disabled' });
  if (env.PUSH_ENABLED && !push.enabled) logger.warn('PUSH_ENABLED but VAPID keys are missing; notifications are stored but not pushed');

  // Graceful shutdown: stop polling, let in-flight work finish, close connections.
  const shutdown = async (sig: string) => {
    if (signal.aborted) return;
    logger.info('shutting down', { signal: sig });
    controller.abort();
    server.close();
    const timeout = setTimeout(() => process.exit(1), 25_000);
    await Promise.allSettled(loops);
    await prisma.$disconnect();
    clearTimeout(timeout);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((e) => {
    logger.error('worker failed to start', { error: errMsg(e) });
    process.exit(1);
  });
}
