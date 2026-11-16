import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
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
  /** Optional ACM certificate for HTTPS on the ALB. Without it the ALB listens on HTTP only (staging). */
  certificateArn?: string;
  /** Public URL of the web portal (e.g. https://tasks.example.com). Defaults to the ALB DNS name. */
  publicUrl?: string;
  /** E-mail address subscribed to CloudWatch alarms. */
  alarmEmail?: string;
  /** Existing Secrets Manager secret holding the Expo access token (optional). */
  expoAccessTokenSecretArn?: string;
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

    /* ------------------------------ Storage ---------------------------- */
    const publicUrl = props.publicUrl;
    const bucket = new s3.Bucket(this, 'Attachments', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: isProd,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      // Browsers upload/download directly with pre-signed URLs; mobile apps do not need CORS.
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
        emailSubject: 'Your DailyTasks account',
        emailBody: 'You have been invited to DailyTasks. Sign in with {username} and temporary password {####}.',
      },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const userPoolClient = userPool.addClient('AppClient', {
      userPoolClientName: `${prefix}-app`,
      generateSecret: false, // public client used by the API on behalf of web and mobile
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
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', { vpc, internetFacing: true, securityGroup: albSg, dropInvalidHeaderFields: true });
    const appUrl = publicUrl ?? `${props.certificateArn ? 'https' : 'http'}://${alb.loadBalancerDnsName}`;

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
    const sharedEnv = {
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      AWS_REGION: this.region,
      S3_BUCKET: bucket.bucketName,
      SQS_EVENTS_QUEUE_URL: queue.queueUrl,
    };

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
      },
      secrets: dbSecrets,
      healthCheck: {
        command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: Duration.seconds(15),
        startPeriod: Duration.seconds(30),
      },
      stopTimeout: Duration.seconds(30),
    });
    bucket.grantReadWrite(apiTd.taskRole);
    apiTd.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser'],
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
      environment: { NODE_ENV: 'production', SEED_DEMO_DATA: 'false' },
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
        PUSH_ENABLED: 'true',
      },
      secrets: {
        ...dbSecrets,
        ...(props.expoAccessTokenSecretArn
          ? { EXPO_ACCESS_TOKEN: ecs.Secret.fromSecretsManager(secretsmanager.Secret.fromSecretCompleteArn(this, 'ExpoToken', props.expoAccessTokenSecretArn)) }
          : {}),
      },
      healthCheck: {
        command: ['CMD-SHELL', "node -e \"fetch('http://127.0.0.1:3002/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""],
        interval: Duration.seconds(30),
        startPeriod: Duration.seconds(30),
      },
      stopTimeout: Duration.seconds(30),
    });
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
        COOKIE_SECURE: props.certificateArn ? 'true' : 'false',
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
    const listener = props.certificateArn
      ? alb.addListener('Https', {
          port: 443,
          certificates: [acm.Certificate.fromCertificateArn(this, 'Cert', props.certificateArn)],
          sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        })
      : alb.addListener('Http', { port: 80 });
    if (props.certificateArn) alb.addRedirect({ sourcePort: 80, targetPort: 443 });

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
    new CfnOutput(this, 'ApiUrl', { value: `${appUrl}/api/v1`, description: 'Set as EXPO_PUBLIC_API_URL for the mobile app' });
    new CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'MigrateTaskDefinition', { value: migrateTd.taskDefinitionArn });
    new CfnOutput(this, 'MigrateSubnets', { value: vpc.privateSubnets.map((s) => s.subnetId).join(',') });
    new CfnOutput(this, 'MigrateSecurityGroup', { value: apiSg.securityGroupId });
    new CfnOutput(this, 'AttachmentsBucket', { value: bucket.bucketName });
    new CfnOutput(this, 'EventsDlqUrl', { value: dlq.queueUrl });
  }
}
