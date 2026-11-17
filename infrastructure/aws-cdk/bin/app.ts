import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { environments } from '../lib/config';
import { DrStack } from '../lib/dr-stack';
import { EdgeStack } from '../lib/edge-stack';
import { MailStack } from '../lib/mail-stack';
import { RegistryStack } from '../lib/registry-stack';

/**
 * Stacks:
 *   DailyTasks-Registry     ECR repositories (shared)
 *   DailyTasks-staging      staging environment
 *   DailyTasks-production   production environment
 *
 * Synthesizing is free and needs no AWS credentials. Deploying creates chargeable resources
 * and must only be done deliberately (see docs/DEPLOYMENT.md).
 */
const app = new App();
const ctx = (key: string): string | undefined => app.node.tryGetContext(key) || undefined;
const num = (key: string): number | undefined => (ctx(key) ? Number(ctx(key)) : undefined);

const env = {
  account: ctx('account') ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: ctx('region') ?? process.env.CDK_DEFAULT_REGION ?? 'me-central-1',
};

new RegistryStack(app, 'DailyTasks-Registry', { env, description: 'DailyTasks container registries' });

// Disaster recovery in the backup region (KMS key for replicated backups + isolated restore-drill
// network). Deployed before DailyTasks-production; never deleted automatically.
const backupRegion = environments.production.db.backupReplicationRegion!;
new DrStack(app, 'DailyTasks-DR', {
  env: { account: env.account, region: backupRegion },
  description: `DailyTasks production disaster recovery (${backupRegion})`,
  sourceRegion: env.region,
  terminationProtection: true,
});

// Edge (us-east-1): CloudFront web ACL for production served on the CloudFront domain (no custom domain).
new EdgeStack(app, 'DailyTasks-Edge', {
  env: { account: env.account, region: 'us-east-1' },
  description: 'DailyTasks production edge: CloudFront WAF (us-east-1)',
  allowedCidrs: ctx('production:allowedCidrs'),
  wafRateLimit: num('production:wafRateLimit'),
  wafAuthRateLimit: num('production:wafAuthRateLimit'),
  alarmEmail: ctx('alarmEmail'),
  logRetentionDays: environments.production.logRetentionDays,
  terminationProtection: true,
});

// SES sending identity for Cognito e-mail (deploy + verify before the application stack).
const mailZoneId = ctx('mail:hostedZoneId') ?? ctx('hostedZoneId');
const mailZoneName = ctx('mail:hostedZoneName') ?? ctx('hostedZoneName');
if (mailZoneId && mailZoneName) {
  new MailStack(app, 'DailyTasks-Mail', { env, description: 'DailyTasks SES identity for Cognito e-mail', hostedZoneId: mailZoneId, hostedZoneName: mailZoneName });
}

for (const config of Object.values(environments)) {
  new AppStack(app, `DailyTasks-${config.name}`, {
    env,
    description: `DailyTasks ${config.name} environment`,
    config,
    imageTag: ctx(`${config.name}:imageTag`) ?? ctx('imageTag') ?? 'latest',
    certificateArn: ctx(`${config.name}:certificateArn`),
    publicUrl: ctx(`${config.name}:publicUrl`),
    domainName: ctx(`${config.name}:domainName`),
    hostedZoneId: ctx(`${config.name}:hostedZoneId`) ?? ctx('hostedZoneId'),
    hostedZoneName: ctx(`${config.name}:hostedZoneName`) ?? ctx('hostedZoneName'),
    alarmEmail: ctx('alarmEmail'),
    vapidPublicKey: ctx(`${config.name}:vapidPublicKey`),
    vapidPrivateKeySecretArn: ctx(`${config.name}:vapidPrivateKeySecretArn`),
    personalDataKeyPreviousSecretArn: ctx(`${config.name}:personalDataKeyPreviousSecretArn`),
    backupReplicaKmsKeyArn: ctx(`${config.name}:backupReplicaKmsKeyArn`),
    edgeWebAclArn: ctx(`${config.name}:edgeWebAclArn`),
    vapidSubject: ctx(`${config.name}:vapidSubject`),
    accessMode: ctx(`${config.name}:accessMode`) as 'open' | 'restricted' | undefined,
    accessAllowlist: ctx(`${config.name}:accessAllowlist`),
    sesFromAddress: ctx(`${config.name}:sesFromAddress`),
    sesFromName: ctx(`${config.name}:sesFromName`),
    allowedCidrs: ctx(`${config.name}:allowedCidrs`),
    wafRateLimit: num(`${config.name}:wafRateLimit`) ?? (config.name === 'staging' && ctx('staging:waf') === 'true' ? 6000 : undefined),
    wafAuthRateLimit: num(`${config.name}:wafAuthRateLimit`),
    terminationProtection: config.name === 'production',
  });
}
