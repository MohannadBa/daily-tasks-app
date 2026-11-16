import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { AppStack } from '../lib/app-stack';
import { environments } from '../lib/config';

const synth = (name: 'staging' | 'production') => {
  const app = new App();
  const stack = new AppStack(app, `Test-${name}`, { env: { account: '111111111111', region: 'me-central-1' }, config: environments[name], imageTag: 'test' });
  return Template.fromStack(stack);
};

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
