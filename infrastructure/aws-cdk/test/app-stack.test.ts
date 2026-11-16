import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack';
import { environments } from '../lib/config';

const ENV = { account: '111111111111', region: 'me-central-1' };
const PROD_HTTPS = { domainName: 'tasks.example.com', hostedZoneId: 'Z0000000000EXAMPLE', hostedZoneName: 'example.com' };
const synth = (name: 'staging' | 'production') => {
  const app = new App();
  const stack = new AppStack(app, `Test-${name}`, { env: ENV, config: environments[name], imageTag: 'test', ...(name === 'production' ? PROD_HTTPS : {}) });
  return Template.fromStack(stack);
};

describe('HTTPS and custom domain', () => {
  it('production refuses to synthesize without HTTPS and a custom https domain', () => {
    const stack = new AppStack(new App(), 'Test-prod-http', { env: ENV, config: environments.production, imageTag: 'test' });
    const errors = Annotations.fromStack(stack).findError('*', Match.stringLikeRegexp('Production requires'));
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
});
