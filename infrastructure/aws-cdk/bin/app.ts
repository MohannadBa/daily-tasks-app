import { App } from 'aws-cdk-lib';
import { AppStack } from '../lib/app-stack';
import { environments } from '../lib/config';
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

const env = {
  account: ctx('account') ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: ctx('region') ?? process.env.CDK_DEFAULT_REGION ?? 'me-central-1',
};

new RegistryStack(app, 'DailyTasks-Registry', { env, description: 'DailyTasks container registries' });

for (const config of Object.values(environments)) {
  new AppStack(app, `DailyTasks-${config.name}`, {
    env,
    description: `DailyTasks ${config.name} environment`,
    config,
    imageTag: ctx(`${config.name}:imageTag`) ?? ctx('imageTag') ?? 'latest',
    certificateArn: ctx(`${config.name}:certificateArn`),
    publicUrl: ctx(`${config.name}:publicUrl`),
    alarmEmail: ctx('alarmEmail'),
    expoAccessTokenSecretArn: ctx(`${config.name}:expoAccessTokenSecretArn`),
    terminationProtection: config.name === 'production',
  });
}
