#!/usr/bin/env node
/**
 * Generates a VAPID key pair for Web Push.   pnpm push:keys
 *
 * Prints the keys once; nothing is written to disk. Store them per environment:
 *   - private key -> AWS Secrets Manager (worker only), e.g.
 *       aws secretsmanager create-secret --name dailytasks/<env>/vapid-private-key --secret-string '<privateKey>'
 *   - public key  -> CDK context `<env>:vapidPublicKey` (it is public by design)
 * Rotating keys invalidates every existing browser subscription (users re-enable notifications).
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/worker/package.json', import.meta.url));
const webpush = require('web-push');
const { publicKey, privateKey } = webpush.generateVAPIDKeys();

console.info('WEB_PUSH_VAPID_PUBLIC_KEY=' + publicKey);
console.info('WEB_PUSH_VAPID_PRIVATE_KEY=' + privateKey);
console.info('\nKeep the private key secret (Secrets Manager). Never commit production keys.');
