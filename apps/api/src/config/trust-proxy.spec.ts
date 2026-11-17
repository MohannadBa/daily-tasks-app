import express from 'express';
import request from 'supertest';
import { apiEnvSchema, loadEnv } from '@dailytasks/config';

/**
 * Pins the Express semantics the deployment relies on: with `trust proxy` = N, req.ip is the
 * N-th address counted from the connecting proxy — client-supplied X-Forwarded-For entries further
 * left are ignored. (The test's socket plays the ALB.)
 */
function ipWith(hops: number, xff: string) {
  const app = express();
  app.set('trust proxy', hops);
  app.get('/', (req, res) => res.send(req.ip));
  return request(app).get('/').set('X-Forwarded-For', xff);
}

describe('trust proxy hops', () => {
  it('ALB only (1 hop): the entry appended by the ALB is the client', async () => {
    expect((await ipWith(1, '6.6.6.6, 198.51.100.7')).text).toBe('198.51.100.7');
  });
  it('CloudFront → ALB (2 hops): the viewer IP appended by CloudFront is the client; spoofed entries ignored', async () => {
    expect((await ipWith(2, '6.6.6.6, 198.51.100.7, 10.0.3.25')).text).toBe('198.51.100.7');
  });
  it('TRUST_PROXY_HOPS is validated (1–3, default 1)', () => {
    const base = {
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      S3_BUCKET: 'bucket',
      SQS_EVENTS_QUEUE_URL: 'http://localhost/queue',
      JWT_SECRET: 'j'.repeat(40),
      PERSONAL_DATA_KEY: 'k'.repeat(40),
    };
    expect(loadEnv(apiEnvSchema, base).TRUST_PROXY_HOPS).toBe(1);
    expect(loadEnv(apiEnvSchema, { ...base, TRUST_PROXY_HOPS: '2' }).TRUST_PROXY_HOPS).toBe(2);
    expect(() => loadEnv(apiEnvSchema, { ...base, TRUST_PROXY_HOPS: '5' })).toThrow('TRUST_PROXY_HOPS');
  });
});
