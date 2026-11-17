import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';
import type { EnvironmentConfig, ServiceSize } from './config';
import { repositoryName, type RepositoryName } from './registry-stack';

export interface AppStackProps extends StackProps {
  config: EnvironmentConfig;
  /** Immutable image tag pushed to ECR (git SHA / release version). */
  imageTag: string;
  /**
   * Existing ACM certificate (same region) for HTTPS on the ALB. Alternatively give `domainName` +
   * hosted zone and the stack creates a DNS-validated certificate. HTTPS is REQUIRED in production:
   * service workers, PWA install, Web Push and Secure cookies do not work over plain HTTP on phones.
   */
  certificateArn?: string;
  /** Custom domain for the app, e.g. tasks.example.com. Used for the certificate, DNS alias and publicUrl. */
  domainName?: string;
  /** Route 53 hosted zone that contains `domainName` (id + name). Enables the alias record and auto certificate. */
  hostedZoneId?: string;
  hostedZoneName?: string;
  /** Public URL of the app (e.g. https://tasks.example.com). Defaults to https://<domainName>, else the ALB DNS name. */
  publicUrl?: string;
  /** E-mail address subscribed to CloudWatch alarms. */
  alarmEmail?: string;
  /**
   * Web Push (VAPID). Generate with `pnpm push:keys`. The public key is public by design (given to
   * browsers); the private key lives only in Secrets Manager and is injected into the worker only.
   * Without both, notifications are still stored in-app but not pushed.
   */
  vapidPublicKey?: string;
  /** ARN of a Secrets Manager secret whose SecretString is the VAPID private key. */
  vapidPrivateKeySecretArn?: string;
  /**
   * Only during a personal-data key rotation: ARN of a secret holding the PREVIOUS key (decrypt
   * fallback). Remove it after rekey-personal has re-encrypted every row. See docs/OPERATIONS.md.
   */
  personalDataKeyPreviousSecretArn?: string;
  /** VAPID contact ("sub" claim) push services can use to reach the operator: mailto:… or https://… */
  vapidSubject?: string;
}

/**
 * One DailyTasks environment (staging or production):
 *   VPC -> ALB -> ECS Fargate (web, api) + worker, RDS PostgreSQL, private S3, SQS (+DLQ),
 *   EventBridge Scheduler group, Cognito user pool, CloudWatch logs/alarms, Secrets Manager.
 */
export class AppStack extends Stack {
  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);
    const { config: cfg } = props;
    const prefix = `dailytasks-${cfg.name}`;
    const isProd = cfg.name === 'production';
    Tags.of(this).add('app', 'dailytasks');
    Tags.of(this).add('environment', cfg.name);

    /* ----------------------------- Network ----------------------------- */
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: cfg.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'app', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 22 },
        { name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    // Keep S3 traffic inside AWS (and off the NAT bill).
    vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    /* ------------------------------ Alarms ----------------------------- */
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', { displayName: `${prefix} alarms` });
    if (props.alarmEmail) alarmTopic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    const alarm = (a: cloudwatch.Alarm) => a.addAlarmAction(new cwActions.SnsAction(alarmTopic));

    /* ----------------------------- Database ---------------------------- */
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', { vpc, description: 'PostgreSQL', allowAllOutbound: false });
    const db = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: new ec2.InstanceType(cfg.db.instanceClass),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      databaseName: 'dailytasks',
      credentials: rds.Credentials.fromGeneratedSecret('dailytasks', { secretName: `${prefix}/db` }),
      multiAz: cfg.db.multiAz,
      allocatedStorage: cfg.db.allocatedStorageGb,
      maxAllocatedStorage: cfg.db.maxAllocatedStorageGb,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      publiclyAccessible: false,
      backupRetention: Duration.days(cfg.db.backupRetentionDays),
      deletionProtection: cfg.db.deletionProtection,
      removalPolicy: isProd ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      enablePerformanceInsights: isProd,
      cloudwatchLogsExports: ['postgresql'],
      parameterGroup: new rds.ParameterGroup(this, 'DbParams', {
        engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
        parameters: { 'rds.force_ssl': '1', log_min_duration_statement: '1000' },
      }),
    });
    const dbSecret = db.secret!;
    alarm(new cloudwatch.Alarm(this, 'DbCpuAlarm', { metric: db.metricCPUUtilization(), threshold: 80, evaluationPeriods: 3, alarmDescription: 'RDS CPU > 80%' }));
    alarm(
      new cloudwatch.Alarm(this, 'DbStorageAlarm', {
        metric: db.metricFreeStorageSpace(),
        threshold: 5 * 1024 ** 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        alarmDescription: 'RDS free storage < 5 GB',
      }),
    );

    /* --------------------------- HTTPS & domain ------------------------ */
    const zone =
      props.hostedZoneId && props.hostedZoneName
        ? route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', { hostedZoneId: props.hostedZoneId, zoneName: props.hostedZoneName })
        : undefined;
    const certificate = props.certificateArn
      ? acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)
      : props.domainName && zone
        ? new acm.Certificate(this, 'Certificate', { domainName: props.domainName, validation: acm.CertificateValidation.fromDns(zone) })
        : undefined;
    const https = !!certificate;
    const publicUrl = props.publicUrl ?? (props.domainName ? `https://${props.domainName}` : undefined);
    if (isProd && !https) {
      Annotations.of(this).addError(
        'Production requires HTTPS: pass -c production:certificateArn=<acm arn> or -c production:domainName=<host> with production:hostedZoneId/hostedZoneName. ' +
          'Service workers, PWA install, Web Push and Secure cookies do not work over HTTP.',
      );
    }
    if (isProd && (!publicUrl || !publicUrl.startsWith('https://'))) {
      Annotations.of(this).addError('Production requires a custom https domain: set production:domainName (or production:publicUrl=https://...).');
    }
    if (!isProd && !https) {
      Annotations.of(this).addWarning('No HTTPS certificate: the app works in desktop browsers, but PWA install, the service worker and push notifications will NOT work on phones.');
    }

    /* ------------------------------ Storage ---------------------------- */
    const bucket = new s3.Bucket(this, 'Attachments', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: isProd,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      // Browsers (incl. the installed PWA) upload/download directly with pre-signed URLs.
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: publicUrl ? [publicUrl] : ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
        // Generated PDF reports are short-lived (the worker also deletes them after REPORT_RETENTION_DAYS).
        { id: 'expire-reports', prefix: 'reports/', expiration: Duration.days(8) },
        ...(isProd ? [{ noncurrentVersionExpiration: Duration.days(90) }] : []),
      ],
    });

    /* ----------------------------- Messaging --------------------------- */
    const dlq = new sqs.Queue(this, 'EventsDlq', {
      queueName: `${prefix}-events-dlq`,
      retentionPeriod: Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
    });
    const queue = new sqs.Queue(this, 'EventsQueue', {
      queueName: `${prefix}-events`,
      visibilityTimeout: Duration.seconds(60),
      receiveMessageWaitTime: Duration.seconds(20),
      retentionPeriod: Duration.days(4),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });
    alarm(
      new cloudwatch.Alarm(this, 'DlqAlarm', {
        metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        alarmDescription: 'Messages landed in the events dead-letter queue',
      }),
    );
    alarm(
      new cloudwatch.Alarm(this, 'QueueAgeAlarm', {
        metric: queue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
        threshold: 300,
        evaluationPeriods: 5,
        alarmDescription: 'Events are not being consumed (oldest message > 5 min)',
      }),
    );

    /* -------------------- EventBridge Scheduler (deadlines) ------------------- */
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'DeadlineScheduleGroup', { name: prefix });
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com', {
        conditions: { StringEquals: { 'aws:SourceAccount': this.account } },
      }),
      description: 'Lets EventBridge Scheduler deliver deadline events to the SQS queue',
    });
    queue.grantSendMessages(schedulerRole);

    /* ------------------------------ Cognito ---------------------------- */
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: prefix,
      selfSignUpEnabled: false, // admins invite users
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 8, requireDigits: true, requireLowercase: true, requireUppercase: true, requireSymbols: false, tempPasswordValidity: Duration.days(7) },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      userInvitation: {
        emailSubject: 'حسابك في الراسيات · Your Al-Rasiyat account',
        emailBody: 'تمت دعوتك إلى منصة مهام الراسيات. اسم المستخدم: {username} — كلمة المرور المؤقتة: {####}<br><br>You have been invited to Al-Rasiyat. Sign in with {username} and temporary password {####}.',
      },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const userPoolClient = userPool.addClient('AppClient', {
      userPoolClientName: `${prefix}-app`,
      generateSecret: false, // public client used by the API on behalf of the web app
      authFlows: { userPassword: true, userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });

    /* ------------------------------ Compute ---------------------------- */
    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: prefix,
      containerInsightsV2: isProd ? ecs.ContainerInsights.ENHANCED : ecs.ContainerInsights.ENABLED,
      defaultCloudMapNamespace: { name: `${prefix}.local` },
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', { vpc, description: 'Public load balancer' });
    // WebSockets (/api/v1/realtime) pass through the ALB; the API pings every 25 s, well inside the idle timeout.
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { vpc, internetFacing: true, securityGroup: albSg, dropInvalidHeaderFields: true, idleTimeout: Duration.seconds(120) });
    const appUrl = publicUrl ?? `${https ? 'https' : 'http'}://${alb.loadBalancerDnsName}`;
    if (zone && props.domainName) {
      new route53.ARecord(this, 'AppAlias', { zone, recordName: props.domainName, target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)) });
    }

    const repos = new Map<RepositoryName, ecr.IRepository>();
    const image = (name: RepositoryName) => {
      if (!repos.has(name)) repos.set(name, ecr.Repository.fromRepositoryName(this, `${name}Repository`, repositoryName(name)));
      return ecs.ContainerImage.fromEcrRepository(repos.get(name)!, props.imageTag);
    };

    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, {
        logGroupName: `/dailytasks/${cfg.name}/${name}`,
        retention: cfg.logRetentionDays as logs.RetentionDays,
        removalPolicy: RemovalPolicy.DESTROY,
      });

    const dbSecrets = {
      DB_HOST: ecs.Secret.fromSecretsManager(dbSecret, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(dbSecret, 'port'),
      DB_USERNAME: ecs.Secret.fromSecretsManager(dbSecret, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
      DB_NAME: ecs.Secret.fromSecretsManager(dbSecret, 'dbname'),
    };
    const pushConfigured = !!(props.vapidPublicKey && props.vapidPrivateKeySecretArn);
    const vapidPublic: Record<string, string> = pushConfigured ? { WEB_PUSH_VAPID_PUBLIC_KEY: props.vapidPublicKey! } : {};
    const sharedEnv = {
      NODE_ENV: 'production',
      // Verify the RDS server certificate (CA bundle baked into the api/worker images).
      DB_SSL_CA_FILE: '/app/certs/rds-global-bundle.pem',
      LOG_LEVEL: 'info',
      AWS_REGION: this.region,
      S3_BUCKET: bucket.bucketName,
      SQS_EVENTS_QUEUE_URL: queue.queueUrl,
    };

    // Personal-task field encryption key (AES-256-GCM, D-12). Generated once and RETAINED: losing it
    // makes existing personal tasks unreadable. Injected into the API only.
    const personalDataKey = new secretsmanager.Secret(this, 'PersonalDataKey', {
      secretName: `${prefix}/personal-data-key`,
      description: 'Encryption key for personal task content (API only). Never rotate without re-encrypting.',
      generateSecretString: { passwordLength: 64, excludePunctuation: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const taskDef = (name: string, size: ServiceSize) =>
      new ecs.FargateTaskDefinition(this, `${name}TaskDef`, {
        cpu: size.cpu,
        memoryLimitMiB: size.memoryMiB,
        runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.X86_64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
      });

    // --- API ---
    const apiSg = new ec2.SecurityGroup(this, 'ApiSg', { vpc, description: 'API tasks' });
    const apiTd = taskDef('Api', cfg.api);
    apiTd.addContainer('api', {
      image: image('api'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logGroup: logGroup('api') }),
      portMappings: [{ containerPort: 3000, name: 'http' }],
      environment: {
        ...sharedEnv,
        PORT: '3000',
        AUTH_MODE: 'cognito',
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        CORS_ORIGINS: appUrl,
        SWAGGER_ENABLED: isProd ? 'false' : 'true',
        RUN_MIGRATIONS: 'false', // migrations run as a one-off task (see docs/DEPLOYMENT.md)
        ...vapidPublic,
      },
      secrets: {
        ...dbSecrets,
        PERSONAL_DATA_KEY: ecs.Secret.fromSecretsManager(personalDataKey),
        ...(props.personalDataKeyPreviousSecretArn
          ? { PERSONAL_DATA_KEY_PREVIOUS: ecs.Secret.fromSecretsManager(secretsmanager.Secret.fromSecretCompleteArn(this, 'PersonalDataKeyPrevious', props.personalDataKeyPreviousSecretArn)) }
          : {}),
      },
      healthCheck: {
        command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: Duration.seconds(15),
        startPeriod: Duration.seconds(30),
      },
      stopTimeout: Duration.seconds(30),
    });
    // Least privilege: the API signs uploads (PutObject) and downloads / HEAD checks (GetObject).
    // It never deletes objects — retention clean-up is the worker's job.
    bucket.grantRead(apiTd.taskRole);
    bucket.grantPut(apiTd.taskRole);
    apiTd.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Admin provisioning: create, enable/disable, reset, set temporary password, revoke sessions.
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminResetUserPassword',
          'cognito-idp:AdminSetUserPassword',
          'cognito-idp:AdminUserGlobalSignOut',
        ],
        resources: [userPool.userPoolArn],
      }),
    );
    const apiService = new ecs.FargateService(this, 'ApiService', {
      cluster,
      serviceName: 'api',
      taskDefinition: apiTd,
      desiredCount: cfg.api.minTasks,
      securityGroups: [apiSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
      cloudMapOptions: { name: 'api' },
      enableExecuteCommand: !isProd,
    });

    // --- Migration task (one-off: `aws ecs run-task ... --overrides command=migrate`) ---
    const migrateTd = taskDef('Migrate', { cpu: 256, memoryMiB: 512, minTasks: 0, maxTasks: 0 });
    migrateTd.addContainer('migrate', {
      image: image('api'),
      command: ['migrate'],
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'migrate', logGroup: logGroup('migrate') }),
      environment: { NODE_ENV: 'production', SEED_DEMO_DATA: 'false', DB_SSL_CA_FILE: '/app/certs/rds-global-bundle.pem' },
      secrets: dbSecrets,
    });

    // --- Worker ---
    const workerSg = new ec2.SecurityGroup(this, 'WorkerSg', { vpc, description: 'Worker tasks' });
    const workerTd = taskDef('Worker', cfg.worker);
    const workerLogs = logGroup('worker');
    workerTd.addContainer('worker', {
      image: image('worker'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'worker', logGroup: workerLogs }),
      environment: {
        ...sharedEnv,
        HEALTH_PORT: '3002',
        SCHEDULER_MODE: 'eventbridge',
        SCHEDULER_GROUP_NAME: scheduleGroup.name!,
        SCHEDULER_TARGET_QUEUE_ARN: queue.queueArn,
        SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
        PUSH_ENABLED: pushConfigured ? 'true' : 'false',
        ...vapidPublic,
        WEB_PUSH_SUBJECT: props.vapidSubject ?? (props.alarmEmail ? `mailto:${props.alarmEmail}` : appUrl.startsWith('https://') ? appUrl : 'mailto:admin@dailytasks.local'),
      },
      secrets: {
        ...dbSecrets,
        // Private key: worker only (the API never sees it).
        ...(pushConfigured
          ? { WEB_PUSH_VAPID_PRIVATE_KEY: ecs.Secret.fromSecretsManager(secretsmanager.Secret.fromSecretCompleteArn(this, 'VapidPrivateKey', props.vapidPrivateKeySecretArn!)) }
          : {}),
      },
      healthCheck: {
        command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:3002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: Duration.seconds(30),
        startPeriod: Duration.seconds(30),
      },
      stopTimeout: Duration.seconds(30),
    });
    // Worker removes abandoned (never confirmed) uploads and expired reports.
    bucket.grantDelete(workerTd.taskRole);
    // Worker writes rendered PDF reports (reports/ prefix only).
    bucket.grantPut(workerTd.taskRole, 'reports/*');
    queue.grantConsumeMessages(workerTd.taskRole);
    queue.grantSendMessages(workerTd.taskRole);
    workerTd.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule', 'scheduler:ListSchedules'],
        resources: [`arn:${this.partition}:scheduler:${this.region}:${this.account}:schedule/${prefix}/*`],
      }),
    );
    // ListSchedules is not resource-scoped.
    workerTd.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['scheduler:ListSchedules'], resources: ['*'] }));
    schedulerRole.grantPassRole(workerTd.taskRole);
    const workerService = new ecs.FargateService(this, 'WorkerService', {
      cluster,
      serviceName: 'worker',
      taskDefinition: workerTd,
      desiredCount: cfg.worker.minTasks,
      securityGroups: [workerSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 0, // single worker can be replaced; work is durable in SQS/outbox
      enableExecuteCommand: !isProd,
    });
    new logs.MetricFilter(this, 'OutboxFailuresFilter', {
      logGroup: workerLogs,
      metricNamespace: 'DailyTasks',
      metricName: `${cfg.name}-worker-errors`,
      filterPattern: logs.FilterPattern.stringValue('$.level', '=', 'error'),
      metricValue: '1',
      defaultValue: 0,
    });
    alarm(
      new cloudwatch.Alarm(this, 'WorkerErrorsAlarm', {
        metric: new cloudwatch.Metric({ namespace: 'DailyTasks', metricName: `${cfg.name}-worker-errors`, statistic: 'Sum', period: Duration.minutes(5) }),
        threshold: 10,
        evaluationPeriods: 1,
        alarmDescription: 'Worker is logging errors (push/outbox/processing failures)',
      }),
    );

    // Push delivery failures (push service errors, timeouts, retries exhausted). Expired
    // subscriptions (404/410) are normal churn and are not counted.
    new logs.MetricFilter(this, 'PushFailuresFilter', {
      logGroup: workerLogs,
      metricNamespace: 'DailyTasks',
      metricName: `${cfg.name}-push-failures`,
      filterPattern: logs.FilterPattern.stringValue('$.msg', '=', 'push delivery failed'),
      metricValue: '1',
      defaultValue: 0,
    });
    alarm(
      new cloudwatch.Alarm(this, 'PushFailuresAlarm', {
        metric: new cloudwatch.Metric({ namespace: 'DailyTasks', metricName: `${cfg.name}-push-failures`, statistic: 'Sum', period: Duration.minutes(15) }),
        threshold: 25,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Web Push deliveries are failing (check VAPID keys, push service status, worker logs)',
      }),
    );

    // --- Web ---
    const webSg = new ec2.SecurityGroup(this, 'WebSg', { vpc, description: 'Web tasks' });
    const webTd = taskDef('Web', cfg.web);
    webTd.addContainer('web', {
      image: image('web'),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web', logGroup: logGroup('web') }),
      portMappings: [{ containerPort: 3000 }],
      environment: {
        NODE_ENV: 'production',
        PORT: '3000',
        // Server-side BFF calls the API over Cloud Map inside the VPC.
        API_INTERNAL_URL: `http://api.${prefix}.local:3000/api/v1`,
        COOKIE_SECURE: https ? 'true' : 'false',
      },
      healthCheck: {
        command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: Duration.seconds(15),
        startPeriod: Duration.seconds(30),
      },
    });
    const webService = new ecs.FargateService(this, 'WebService', {
      cluster,
      serviceName: 'web',
      taskDefinition: webTd,
      desiredCount: cfg.web.minTasks,
      securityGroups: [webSg],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      minHealthyPercent: 100,
    });

    // --- Security group rules (least privilege) ---
    apiSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'ALB to API');
    apiSg.addIngressRule(webSg, ec2.Port.tcp(3000), 'Web BFF to API');
    webSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'ALB to web');
    dbSg.addIngressRule(apiSg, ec2.Port.tcp(5432), 'API and migration task to DB');
    dbSg.addIngressRule(workerSg, ec2.Port.tcp(5432), 'Worker to DB');

    /* --------------------------- Load balancer -------------------------- */
    const listener = certificate
      ? alb.addListener('Https', { port: 443, certificates: [certificate], sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS })
      : alb.addListener('Http', { port: 80 });
    if (certificate) alb.addRedirect({ sourcePort: 80, targetPort: 443 });

    listener.addTargets('Web', {
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(20),
    });
    listener.addTargets('Api', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*', '/health'])],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(20),
    });

    alarm(
      new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
        metric: alb.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT, { period: Duration.minutes(5), statistic: 'Sum' }),
        threshold: 20,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
        alarmDescription: 'Elevated 5xx responses from targets',
      }),
    );

    /* ----------------------------- Scaling ----------------------------- */
    const scale = (svc: ecs.FargateService, size: ServiceSize, name: string) => {
      if (size.maxTasks <= size.minTasks) return;
      svc.autoScaleTaskCount({ minCapacity: size.minTasks, maxCapacity: size.maxTasks }).scaleOnCpuUtilization(`${name}Cpu`, { targetUtilizationPercent: 60 });
    };
    scale(apiService, cfg.api, 'Api');
    scale(webService, cfg.web, 'Web');
    scale(workerService, cfg.worker, 'Worker');
    for (const [name, svc] of [['Api', apiService], ['Web', webService], ['Worker', workerService]] as const) {
      alarm(new cloudwatch.Alarm(this, `${name}CpuAlarm`, { metric: svc.metricCpuUtilization(), threshold: 85, evaluationPeriods: 3, alarmDescription: `${name} CPU > 85%` }));
    }

    /* ------------------------------ Outputs ---------------------------- */
    new CfnOutput(this, 'AppUrl', { value: appUrl });
    new CfnOutput(this, 'ApiUrl', { value: `${appUrl}/api/v1`, description: 'Public REST API base URL' });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'MigrateTaskDefinition', { value: migrateTd.taskDefinitionArn });
    // For one-off tasks that need the API's secrets (e.g. rekey-personal during a key rotation).
    new CfnOutput(this, 'ApiTaskDefinition', { value: apiTd.taskDefinitionArn });
    new CfnOutput(this, 'MigrateSubnets', { value: vpc.privateSubnets.map((s) => s.subnetId).join(',') });
    new CfnOutput(this, 'MigrateSecurityGroup', { value: apiSg.securityGroupId });
    new CfnOutput(this, 'AttachmentsBucket', { value: bucket.bucketName });
    new CfnOutput(this, 'EventsDlqUrl', { value: dlq.queueUrl });
  }
}
