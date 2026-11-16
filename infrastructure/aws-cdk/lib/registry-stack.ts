import { RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import type { Construct } from 'constructs';

export const REPOSITORIES = ['api', 'worker', 'web'] as const;
export type RepositoryName = (typeof REPOSITORIES)[number];
export const repositoryName = (n: RepositoryName) => `dailytasks/${n}`;

/**
 * Container registries shared by staging and production. Images are built and pushed by CI
 * (scripts/push-images.sh) and referenced by immutable tag from the environment stacks.
 */
export class RegistryStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    for (const name of REPOSITORIES) {
      new ecr.Repository(this, `${name}Repo`, {
        repositoryName: repositoryName(name),
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: RemovalPolicy.RETAIN,
        lifecycleRules: [{ description: 'Keep the last 50 images', maxImageCount: 50 }],
      });
    }
  }
}
