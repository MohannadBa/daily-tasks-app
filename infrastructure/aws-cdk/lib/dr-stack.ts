import { CfnOutput, Duration, RemovalPolicy, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as rds from 'aws-cdk-lib/aws-rds';
import type { Construct } from 'constructs';

/**
 * Disaster-recovery resources in the BACKUP region (eu-west-1 / Ireland). Deployed before the
 * production stack, which replicates its RDS automated backups here:
 *
 *  - BackupKey: customer-managed KMS key that encrypts the replicated automated backups and the
 *    copied manual snapshots. Retained on stack deletion, yearly rotation, and protected against
 *    being disabled or scheduled for deletion (a human must first edit the key policy on purpose):
 *    losing this key would make every Ireland backup unreadable.
 *  - Restore-drill network: an isolated VPC (no internet gateway, no NAT — no hourly cost), a DB
 *    subnet group and a security group with NO inbound and NO outbound rules. Restore drills land
 *    here and are unreachable by design; in a real regional disaster the full application stack is
 *    deployed to this region and the restore uses its own network (docs/OPERATIONS.md §1b).
 */
export class DrStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps & { sourceRegion: string }) {
    super(scope, id, props);
    Tags.of(this).add('app', 'dailytasks');
    Tags.of(this).add('environment', 'production-dr');

    const key = new kms.Key(this, 'BackupKey', {
      alias: 'alias/dailytasks-production-backups',
      description: `DailyTasks production: RDS backups replicated from ${props.sourceRegion}`,
      enableKeyRotation: true,
      pendingWindow: Duration.days(30),
      removalPolicy: RemovalPolicy.RETAIN,
    });
    // RDS (in this region, for this account) may use the key for replicated backups / snapshot copies.
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowRdsUseViaService',
        principals: [new iam.AccountRootPrincipal()],
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:CreateGrant', 'kms:DescribeKey', 'kms:ListGrants'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `rds.${this.region}.amazonaws.com`, 'kms:CallerAccount': this.account } },
      }),
    );
    // Guard rail: nobody can disable or schedule deletion of the backup key without first changing this policy.
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyDisableOrDeleteBackupKey',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:ScheduleKeyDeletion', 'kms:DisableKey'],
        resources: ['*'],
      }),
    );

    const vpc = new ec2.Vpc(this, 'DrillVpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }],
    });
    const sg = new ec2.SecurityGroup(this, 'DrillDbSg', { vpc, description: 'Restore drills: no inbound, no outbound', allowAllOutbound: false });
    const subnetGroup = new rds.SubnetGroup(this, 'DrillSubnetGroup', {
      vpc,
      description: 'DailyTasks restore drills (isolated)',
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    new CfnOutput(this, 'BackupKeyArn', { value: key.keyArn, description: 'Pass as production:backupReplicaKmsKeyArn' });
    new CfnOutput(this, 'DrillSubnetGroupName', { value: subnetGroup.subnetGroupName });
    new CfnOutput(this, 'DrillSecurityGroupId', { value: sg.securityGroupId });
  }
}
