import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack';
import { DrStack } from '../lib/dr-stack';
import { MailStack } from '../lib/mail-stack';
import { environments } from '../lib/config';

const ENV = { account: '111111111111', region: 'eu-north-1' };
const PROD_HTTPS = { domainName: 'tasks.example.com', hostedZoneId: 'Z0000000000EXAMPLE', hostedZoneName: 'example.com' };
/** A complete production configuration: HTTPS, SES for Cognito, restricted acceptance allow-list. */
const IRELAND_KEY = 'arn:aws:kms:eu-west-1:111111111111:key/12345678-1234-1234-1234-123456789012';
const PROD = { ...PROD_HTTPS, sesFromAddress: 'no-reply@example.com', accessAllowlist: 'admin@example.com,qa@example.com', backupReplicaKmsKeyArn: IRELAND_KEY };
const synth = (name: 'staging' | 'production') => {
  const app = new App();
  const stack = new AppStack(app, `Test-${name}`, { env: ENV, config: environments[name], imageTag: 'test', ...(name === 'production' ? PROD : {}) });
  return Template.fromStack(stack);
};

describe('HTTPS and custom domain', () => {
  it('production refuses to synthesize without HTTPS and a custom https domain', () => {
    const stack = new AppStack(new App(), 'Test-prod-http', { env: ENV, config: environments.production, imageTag: 'test' });
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('Production requires (HTTPS|a custom)'));
    expect(errors.length).toBe(2);
  });

  it('domain + hosted zone: DNS-validated certificate, HTTPS listener, HTTP->HTTPS redirect, alias record, Secure cookies, CORS pinned', () => {
    const t = synth('production');
    t.hasResourceProperties('AWS::CertificateManager::Certificate', { DomainName: 'tasks.example.com', ValidationMethod: 'DNS' });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 443, Protocol: 'HTTPS' });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [Match.objectLike({ Type: 'redirect', RedirectConfig: Match.objectLike({ Protocol: 'HTTPS', Port: '443' }) })],
    });
    t.hasResourceProperties('AWS::Route53::RecordSet', { Name: 'tasks.example.com.', Type: 'A' });
    const containers = Object.values(t.findResources('AWS::ECS::TaskDefinition')).flatMap(
      (r) => (r as { Properties: { ContainerDefinitions: Array<{ Name: string; Environment?: Array<{ Name: string; Value: unknown }> }> } }).Properties.ContainerDefinitions,
    );
    const env = (c: string, k: string) => containers.find((x) => x.Name === c)?.Environment?.find((e) => e.Name === k)?.Value;
    expect(env('web', 'COOKIE_SECURE')).toBe('true');
    expect(env('api', 'CORS_ORIGINS')).toBe('https://tasks.example.com');
    t.hasResourceProperties('AWS::S3::Bucket', { CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedOrigins: ['https://tasks.example.com'] })] } });
  });

  it('staging without a certificate only warns (PWA/push will not work on phones)', () => {
    const stack = new AppStack(new App(), 'Test-staging-http', { env: ENV, config: environments.staging, imageTag: 'test' });
    expect(Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('No HTTPS certificate')).length).toBe(1);
    expect(Annotations.fromStack(stack).findError('*', Match.anyValue()).length).toBe(0);
  });
});

describe('Web Push configuration', () => {
  const app = new App();
  const stack = new AppStack(app, 'Test-push', {
    env: { account: '111111111111', region: 'me-central-1' },
    config: environments.production,
    imageTag: 'test',
    ...PROD_HTTPS,
    vapidPublicKey: 'BPublicKeyForTests',
    vapidPrivateKeySecretArn: 'arn:aws:secretsmanager:me-central-1:111111111111:secret:dailytasks/vapid-AbCdEf',
    alarmEmail: 'ops@example.com',
  });
  const t = Template.fromStack(stack);
  const containers = () =>
    Object.values(t.findResources('AWS::ECS::TaskDefinition')).flatMap(
      (r) => (r as { Properties: { ContainerDefinitions: Array<{ Name: string; Environment?: Array<{ Name: string; Value: unknown }>; Secrets?: Array<{ Name: string }> }> } }).Properties.ContainerDefinitions,
    );

  it('injects the VAPID private key into the worker only, as a secret', () => {
    const worker = containers().find((c) => c.Name === 'worker')!;
    const api = containers().find((c) => c.Name === 'api')!;
    expect(worker.Secrets?.map((s) => s.Name)).toContain('WEB_PUSH_VAPID_PRIVATE_KEY');
    expect(worker.Environment?.find((e) => e.Name === 'WEB_PUSH_VAPID_PRIVATE_KEY')).toBeUndefined();
    expect(worker.Environment?.find((e) => e.Name === 'PUSH_ENABLED')?.Value).toBe('true');
    expect(worker.Environment?.find((e) => e.Name === 'WEB_PUSH_SUBJECT')?.Value).toBe('mailto:ops@example.com');
    expect(api.Environment?.find((e) => e.Name === 'WEB_PUSH_VAPID_PUBLIC_KEY')?.Value).toBe('BPublicKeyForTests');
    expect([...(api.Secrets ?? []).map((s) => s.Name), ...(api.Environment ?? []).map((e) => e.Name)]).not.toContain('WEB_PUSH_VAPID_PRIVATE_KEY');
  });

  it('alarms on push delivery failures', () => {
    t.hasResourceProperties('AWS::Logs::MetricFilter', { FilterPattern: '{ $.msg = "push delivery failed" }' });
    t.hasResourceProperties('AWS::CloudWatch::Alarm', { MetricName: 'production-push-failures', Threshold: 25 });
  });

  it('push stays off (stored in-app only) until VAPID keys are configured', () => {
    const plain = Template.fromStack(new AppStack(new App(), 'Test-nopush', { env: { account: '111111111111', region: 'me-central-1' }, config: environments.staging, imageTag: 'test' }));
    const worker = Object.values(plain.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((r) => (r as { Properties: { ContainerDefinitions: Array<{ Name: string; Environment?: Array<{ Name: string; Value: unknown }> }> } }).Properties.ContainerDefinitions)
      .find((c) => c.Name === 'worker')!;
    expect(worker.Environment?.find((e) => e.Name === 'PUSH_ENABLED')?.Value).toBe('false');
  });
});

describe('AppStack', () => {
  const prod = synth('production');
  const staging = synth('staging');

  it('S3 attachments bucket is private, encrypted and TLS-only', () => {
    prod.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: Match.objectLike({}),
    });
    prod.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });

  it('RDS is private, encrypted, multi-AZ and protected in production', () => {
    prod.hasResourceProperties('AWS::RDS::DBInstance', { PubliclyAccessible: false, StorageEncrypted: true, MultiAZ: true, DeletionProtection: true });
    staging.hasResourceProperties('AWS::RDS::DBInstance', { MultiAZ: false });
  });

  it('events queue has a dead-letter queue after 5 receives', () => {
    prod.hasResourceProperties('AWS::SQS::Queue', {
      RedrivePolicy: { deadLetterTargetArn: Match.anyValue(), maxReceiveCount: 5 },
    });
  });

  it('Cognito disallows self sign-up', () => {
    prod.hasResourceProperties('AWS::Cognito::UserPool', { AdminCreateUserConfig: Match.objectLike({ AllowAdminCreateUserOnly: true }) });
  });

  it('runs api, web and worker on Fargate with an EventBridge schedule group', () => {
    expect(Object.keys(prod.findResources('AWS::ECS::Service'))).toHaveLength(3);
    prod.resourceCountIs('AWS::Scheduler::ScheduleGroup', 1);
    prod.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'worker',
          Environment: Match.arrayWith([{ Name: 'SCHEDULER_MODE', Value: 'eventbridge' }]),
        }),
      ]),
    });
  });

  it('API uses Cognito auth and never receives plaintext DB credentials', () => {
    prod.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'api',
          Environment: Match.arrayWith([{ Name: 'AUTH_MODE', Value: 'cognito' }]),
          Secrets: Match.arrayWith([Match.objectLike({ Name: 'DB_PASSWORD' })]),
        }),
      ]),
    });
  });

  it('alarms on the dead-letter queue', () => {
    prod.hasResourceProperties('AWS::CloudWatch::Alarm', { AlarmDescription: 'Messages landed in the events dead-letter queue' });
  });
  it('enterprise: personal-data key is a retained secret injected into the API only', () => {
    prod.hasResource('AWS::SecretsManager::Secret', { DeletionPolicy: 'Retain', Properties: Match.objectLike({ Name: Match.stringLikeRegexp('personal-data-key') }) });
    const defs = Object.values(prod.findResources('AWS::ECS::TaskDefinition')).flatMap(
      (r) => (r as { Properties: { ContainerDefinitions: Array<{ Name: string; Secrets?: Array<{ Name: string }> }> } }).Properties.ContainerDefinitions,
    );
    const holders = defs.filter((c) => c.Secrets?.some((x) => x.Name === 'PERSONAL_DATA_KEY')).map((c) => c.Name);
    expect(holders).toEqual(['api']);
  });

  it('enterprise: API may set temporary passwords and revoke sessions in Cognito', () => {
    const policies = JSON.stringify(prod.findResources('AWS::IAM::Policy'));
    expect(policies).toContain('cognito-idp:AdminSetUserPassword');
    expect(policies).toContain('cognito-idp:AdminUserGlobalSignOut');
  });

  it('least privilege: the API role cannot delete S3 objects; only the worker can', () => {
    const policies = Object.entries(prod.findResources('AWS::IAM::Policy')) as Array<[string, { Properties: { PolicyDocument: { Statement: Array<{ Action: string | string[] }> } } }]>;
    const actions = (prefix: string) =>
      policies.filter(([id]) => id.startsWith(prefix)).flatMap(([, p]) => p.Properties.PolicyDocument.Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])));
    const api = actions('ApiTaskDefTaskRole');
    expect(api).toEqual(expect.arrayContaining(['s3:GetObject*', 's3:PutObject']));
    expect(api.filter((a) => a.startsWith('s3:Delete'))).toEqual([]);
    expect(actions('WorkerTaskDefTaskRole')).toContain('s3:DeleteObject*');
  });

  it('database TLS: api, worker and migrate verify the RDS certificate with the bundled CA', () => {
    const defs = Object.values(prod.findResources('AWS::ECS::TaskDefinition')).flatMap(
      (r) => (r as { Properties: { ContainerDefinitions: Array<{ Name: string; Environment?: Array<{ Name: string; Value: unknown }> }> } }).Properties.ContainerDefinitions,
    );
    for (const name of ['api', 'worker', 'migrate']) {
      expect(defs.find((c) => c.Name === name)?.Environment?.find((e) => e.Name === 'DB_SSL_CA_FILE')?.Value).toBe('/app/certs/rds-global-bundle.pem');
    }
  });

  it('enterprise: worker has memory for Chromium and reports expire', () => {
    prod.hasResourceProperties('AWS::ECS::TaskDefinition', { Family: Match.stringLikeRegexp('Worker'), Memory: '2048' });
    prod.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: Match.arrayWith([Match.objectLike({ Prefix: 'reports/', ExpirationInDays: 8, Status: 'Enabled' })]) },
    });
  });
});

describe('production-first launch', () => {
  const build = (extra: Record<string, unknown> = {}) => new AppStack(new App(), 'Test-prod-launch', { env: ENV, config: environments.production, imageTag: 'test', ...PROD, ...extra });
  const apiEnv = (t: Template) => {
    const defs = t.findResources('AWS::ECS::TaskDefinition');
    const api = Object.values(defs).flatMap((d) => (d as { Properties: { ContainerDefinitions: Array<{ Name: string; Environment?: Array<{ Name: string; Value: unknown }> }> } }).Properties.ContainerDefinitions).find((c) => c.Name === 'api')!;
    return Object.fromEntries((api.Environment ?? []).map((e) => [e.Name, e.Value]));
  };

  it('production starts in RESTRICTED acceptance mode and refuses to synthesize without an allow-list', () => {
    const missing = build({ accessAllowlist: undefined });
    expect(Annotations.fromStack(missing).findError('*', Match.stringLikeRegexp('restricted acceptance mode')).length).toBe(1);
    const env = apiEnv(Template.fromStack(build()));
    expect(env.ACCESS_MODE).toBe('restricted');
    expect(env.ACCESS_ALLOWLIST).toBe('admin@example.com,qa@example.com');
    expect(env.SWAGGER_ENABLED).toBe('false');
    const bad = build({ accessAllowlist: 'admin@example.com,not-an-email' });
    expect(Annotations.fromStack(bad).findError('*', Match.stringLikeRegexp('not an e-mail')).length).toBe(1);
  });

  it('opening access is an explicit redeploy with accessMode=open (no allow-list sent)', () => {
    const env = apiEnv(Template.fromStack(build({ accessMode: 'open', accessAllowlist: undefined })));
    expect(env.ACCESS_MODE).toBe('open');
    expect(env.ACCESS_ALLOWLIST).toBeUndefined();
  });

  it('Cognito sends e-mail through SES from the verified domain, and the pool is deletion-protected', () => {
    const t = Template.fromStack(build());
    t.hasResourceProperties('AWS::Cognito::UserPool', {
      DeletionProtection: 'ACTIVE',
      EmailConfiguration: Match.objectLike({ EmailSendingAccount: 'DEVELOPER', From: Match.stringLikeRegexp('no-reply@example.com'), SourceArn: Match.anyValue() }),
    });
    const noSes = build({ sesFromAddress: undefined });
    expect(Annotations.fromStack(noSes).findError('*', Match.stringLikeRegexp('requires SES')).length).toBe(1);
    const wrongDomain = build({ sesFromAddress: 'no-reply@other.org' });
    expect(Annotations.fromStack(wrongDomain).findError('*', Match.stringLikeRegexp('hosted-zone domain')).length).toBe(1);
  });

  it('WAF: managed rules + sign-in and global rate limits on the ALB; tokens/cookies redacted from WAF logs', () => {
    const t = Template.fromStack(build());
    t.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1);
    t.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
      Rules: Match.arrayWith([
        Match.objectLike({ Name: 'AWSManagedRulesCommonRuleSet' }),
        Match.objectLike({ Name: 'rate-limit-sign-in', Action: { Block: {} }, Statement: { RateBasedStatement: Match.objectLike({ Limit: 200, AggregateKeyType: 'IP' }) } }),
        Match.objectLike({ Name: 'rate-limit-all', Statement: { RateBasedStatement: Match.objectLike({ Limit: 6000 }) } }),
      ]),
    });
    t.hasResourceProperties('AWS::WAFv2::LoggingConfiguration', {
      RedactedFields: [{ SingleHeader: { Name: 'authorization' } }, { SingleHeader: { Name: 'cookie' } }],
    });
    // Optional IP allow-list blocks everything else.
    const ip = Template.fromStack(build({ allowedCidrs: '203.0.113.0/24' }));
    ip.hasResourceProperties('AWS::WAFv2::IPSet', { Addresses: ['203.0.113.0/24'] });
    ip.hasResourceProperties('AWS::WAFv2::WebACL', { Rules: Match.arrayWith([Match.objectLike({ Name: 'block-outside-allowlist', Priority: 0, Action: { Block: {} } })]) });
    // Staging: no WAF unless asked for.
    Template.fromStack(new AppStack(new App(), 'Test-stg-waf', { env: ENV, config: environments.staging, imageTag: 'test' })).resourceCountIs('AWS::WAFv2::WebACL', 0);
  });

  it('production keeps evidence and data: logs, user pool, bucket, DB snapshot; ALB access logs on', () => {
    const t = Template.fromStack(build());
    for (const lg of Object.values(t.findResources('AWS::Logs::LogGroup'))) expect((lg as { DeletionPolicy: string }).DeletionPolicy).toBe('Retain');
    for (const b of Object.values(t.findResources('AWS::S3::Bucket'))) expect((b as { DeletionPolicy: string }).DeletionPolicy).toBe('Retain');
    for (const p of Object.values(t.findResources('AWS::Cognito::UserPool'))) expect((p as { DeletionPolicy: string }).DeletionPolicy).toBe('Retain');
    for (const sec of Object.values(t.findResources('AWS::SecretsManager::Secret'))) expect((sec as { DeletionPolicy: string }).DeletionPolicy).toBe('Retain');
    for (const d of Object.values(t.findResources('AWS::RDS::DBInstance'))) expect((d as { DeletionPolicy: string }).DeletionPolicy).toBe('Snapshot');
    t.hasResourceProperties('AWS::RDS::DBInstance', { BackupRetentionPeriod: 14, PreferredBackupWindow: '23:00-00:00', CopyTagsToSnapshot: true });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      LoadBalancerAttributes: Match.arrayWith([{ Key: 'access_logs.s3.enabled', Value: 'true' }]),
    });
    t.hasOutput('DatabaseInstanceId', {});
    for (const name of ['ApiUnhealthyHostsAlarm', 'WebUnhealthyHostsAlarm', 'DbMemoryAlarm', 'DbConnectionsAlarm', 'WafSignInBlocksAlarm']) {
      expect(Object.keys(t.findResources('AWS::CloudWatch::Alarm')).some((k) => k.startsWith(name))).toBe(true);
    }
  });

  it('mail stack: SES domain identity with DKIM records in the hosted zone, retained', () => {
    const t = Template.fromStack(new MailStack(new App(), 'Test-mail', { env: ENV, hostedZoneId: 'Z0000000000EXAMPLE', hostedZoneName: 'example.com' }));
    t.hasResourceProperties('AWS::SES::EmailIdentity', { EmailIdentity: 'example.com', MailFromAttributes: { MailFromDomain: 'ses-bounce.example.com' } });
    t.resourceCountIs('AWS::Route53::RecordSet', 5); // 3 DKIM CNAME + MAIL FROM MX + SPF TXT
    for (const r of Object.values(t.findResources('AWS::SES::EmailIdentity'))) expect((r as { DeletionPolicy: string }).DeletionPolicy).toBe('Retain');
  });
});

describe('cross-region backups (production eu-north-1 → eu-west-1)', () => {
  const NORTH = { account: '111111111111', region: 'eu-north-1' };
  const prod = (extra: Record<string, unknown> = {}) => new AppStack(new App(), 'Test-prod-dr', { env: NORTH, config: environments.production, imageTag: 'test', ...PROD, ...extra });

  it('the decided backup region is eu-west-1 with 14-day retention; staging does not replicate', () => {
    expect(environments.production.db.backupReplicationRegion).toBe('eu-west-1');
    expect(environments.production.db.backupRetentionDays).toBe(14);
    expect(environments.staging.db.backupReplicationRegion).toBeUndefined();
  });

  it('replicates automated backups to Ireland, encrypted with the Ireland key, 14 days, kept when the instance is deleted', () => {
    const t = Template.fromStack(prod());
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      StorageEncrypted: true,
      BackupRetentionPeriod: 14,
      AutomaticBackupReplicationRegion: 'eu-west-1',
      AutomaticBackupReplicationRetentionPeriod: 14,
      AutomaticBackupReplicationKmsKeyId: IRELAND_KEY,
      DeleteAutomatedBackups: false,
      DeletionProtection: true,
    });
    for (const d of Object.values(t.findResources('AWS::RDS::DBInstance'))) {
      expect((d as { DeletionPolicy: string }).DeletionPolicy).toBe('Snapshot');
      expect((d as { UpdateReplacePolicy: string }).UpdateReplacePolicy).toBe('Snapshot');
    }
    t.hasOutput('BackupReplicationRegion', { Value: 'eu-west-1' });
  });

  it('refuses to synthesize without the Ireland key, or with a key from another region', () => {
    const missing = prod({ backupReplicaKmsKeyArn: undefined });
    expect(Annotations.fromStack(missing).findError('*', Match.stringLikeRegexp('deploy DailyTasks-DR first')).length).toBe(1);
    const wrong = prod({ backupReplicaKmsKeyArn: 'arn:aws:kms:eu-north-1:111111111111:key/12345678-1234-1234-1234-123456789012' });
    expect(Annotations.fromStack(wrong).findError('*', Match.stringLikeRegexp('KMS key ARN in eu-west-1')).length).toBe(1);
    expect(Annotations.fromStack(prod()).findError('*', Match.anyValue()).length).toBe(0);
  });

  it('staging keeps the old behaviour (no replication, automated backups removed with the instance)', () => {
    const t = Template.fromStack(new AppStack(new App(), 'Test-stg-dr', { env: NORTH, config: environments.staging, imageTag: 'test' }));
    const db = Object.values(t.findResources('AWS::RDS::DBInstance'))[0] as { Properties: Record<string, unknown> };
    expect(db.Properties.AutomaticBackupReplicationRegion).toBeUndefined();
    expect(db.Properties.DeleteAutomatedBackups).toBe(true);
  });

  it('DR stack: retained, rotating backup key that cannot be disabled or scheduled for deletion; isolated drill network', () => {
    const t = Template.fromStack(new DrStack(new App(), 'Test-dr', { env: { account: '111111111111', region: 'eu-west-1' }, sourceRegion: 'eu-north-1' }));
    const keys = t.findResources('AWS::KMS::Key');
    expect(Object.keys(keys)).toHaveLength(1);
    const key = Object.values(keys)[0] as { DeletionPolicy: string; UpdateReplacePolicy: string; Properties: Record<string, unknown> };
    expect(key.DeletionPolicy).toBe('Retain');
    expect(key.UpdateReplacePolicy).toBe('Retain');
    expect(key.Properties).toMatchObject({ EnableKeyRotation: true, PendingWindowInDays: 30 });
    const statements = (key.Properties.KeyPolicy as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Sid: 'DenyDisableOrDeleteBackupKey', Effect: 'Deny', Action: ['kms:ScheduleKeyDeletion', 'kms:DisableKey'] }),
        expect.objectContaining({ Sid: 'AllowRdsUseViaService', Effect: 'Allow', Condition: { StringEquals: expect.objectContaining({ 'kms:ViaService': 'rds.eu-west-1.amazonaws.com' }) } }),
      ]),
    );
    // The account root keeps key administration (policy can be changed deliberately; no lock-out).
    expect(statements.some((st) => st.Effect === 'Allow' && JSON.stringify(st.Action).includes('kms:*'))).toBe(true);
    t.hasResourceProperties('AWS::KMS::Alias', { AliasName: 'alias/dailytasks-production-backups' });
    // No internet path and no hourly network cost; drill DB unreachable.
    t.resourceCountIs('AWS::EC2::NatGateway', 0);
    t.resourceCountIs('AWS::EC2::InternetGateway', 0);
    const sgs = Object.values(t.findResources('AWS::EC2::SecurityGroup')).map((r) => (r as { Properties: Record<string, unknown> }).Properties);
    const drill = sgs.find((p) => p.GroupDescription === 'Restore drills: no inbound, no outbound')!;
    expect(drill.SecurityGroupIngress).toBeUndefined();
    expect(JSON.stringify(drill.SecurityGroupEgress)).toContain('255.255.255.255/32'); // CDK's "no outbound" placeholder
    for (const g of Object.values(t.findResources('AWS::RDS::DBSubnetGroup'))) expect((g as { DeletionPolicy: string }).DeletionPolicy).toBe('Retain');
  });
});

describe('region pin (R2)', () => {
  const build = (env: { account: string; region?: string }) => new AppStack(new App(), 'Test-prod-region', { env, config: environments.production, imageTag: 'test', ...PROD });
  const errors = (st: AppStack) => Annotations.fromStack(st).findError('*', Match.stringLikeRegexp('fixed to eu-north-1|explicit region'));

  it('production is fixed to eu-north-1', () => {
    expect(environments.production.requiredRegion).toBe('eu-north-1');
    expect(errors(build({ account: '111111111111', region: 'eu-north-1' }))).toHaveLength(0);
  });
  it('refuses any other region, and an environment-agnostic synth', () => {
    for (const region of ['eu-central-1', 'eu-west-1', 'me-central-1', 'us-east-1']) expect(errors(build({ account: '111111111111', region }))).toHaveLength(1);
    // No region at all: CDK already refuses (ALB access logs need a concrete region) before our check.
    expect(() => build({ account: '111111111111' })).toThrow(/Region is required/);
  });
  it('staging is not pinned', () => {
    const st = new AppStack(new App(), 'Test-stg-region', { env: { account: '111111111111', region: 'eu-central-1' }, config: environments.staging, imageTag: 'test' });
    expect(errors(st as AppStack)).toHaveLength(0);
  });
});
