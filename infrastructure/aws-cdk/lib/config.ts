/**
 * Per-environment settings. Everything chargeable is sized here so staging stays cheap.
 * Override at synth/deploy time with CDK context, e.g.:
 *   cdk deploy DailyTasks-production -c imageTag=1.4.0 -c certificateArn=arn:aws:acm:... -c alarmEmail=ops@example.com
 */
export interface EnvironmentConfig {
  name: 'staging' | 'production';
  /** NAT gateways: 1 in staging (cost), 2 in production (AZ resilience). */
  natGateways: number;
  db: {
    instanceClass: string; // e.g. t4g.micro
    multiAz: boolean;
    allocatedStorageGb: number;
    maxAllocatedStorageGb: number;
    backupRetentionDays: number;
    deletionProtection: boolean;
  };
  api: ServiceSize;
  web: ServiceSize;
  worker: ServiceSize;
  logRetentionDays: number;
}

export interface ServiceSize {
  cpu: number;
  memoryMiB: number;
  minTasks: number;
  maxTasks: number;
}

export const environments: Record<EnvironmentConfig['name'], EnvironmentConfig> = {
  staging: {
    name: 'staging',
    natGateways: 1,
    db: { instanceClass: 't4g.micro', multiAz: false, allocatedStorageGb: 20, maxAllocatedStorageGb: 50, backupRetentionDays: 3, deletionProtection: false },
    api: { cpu: 256, memoryMiB: 512, minTasks: 1, maxTasks: 2 },
    web: { cpu: 256, memoryMiB: 512, minTasks: 1, maxTasks: 2 },
    // Headless Chromium (PDF reports) needs >= 1 GB.
    worker: { cpu: 512, memoryMiB: 1024, minTasks: 1, maxTasks: 1 },
    logRetentionDays: 14,
  },
  production: {
    name: 'production',
    natGateways: 2,
    db: { instanceClass: 't4g.medium', multiAz: true, allocatedStorageGb: 50, maxAllocatedStorageGb: 500, backupRetentionDays: 14, deletionProtection: true },
    api: { cpu: 512, memoryMiB: 1024, minTasks: 2, maxTasks: 6 },
    web: { cpu: 512, memoryMiB: 1024, minTasks: 2, maxTasks: 4 },
    worker: { cpu: 512, memoryMiB: 2048, minTasks: 1, maxTasks: 3 },
    logRetentionDays: 90,
  },
};
