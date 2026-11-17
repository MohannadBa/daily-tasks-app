import { Annotations, CfnOutput, Stack, Tags, type StackProps } from 'aws-cdk-lib';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Construct } from 'constructs';
import { validAlarmEmail } from './alarm-email';
import { createWebAcl, signInBlocksAlarm } from './waf';

export interface EdgeStackProps extends StackProps {
  /** Optional WAF IP allow-list (CIDRs, comma-separated). */
  allowedCidrs?: string;
  wafRateLimit?: number;
  wafAuthRateLimit?: number;
  /** Ops mailbox for the edge alarm; omitted = alarm without e-mail delivery (see docs). */
  alarmEmail?: string;
  logRetentionDays: number;
}

/**
 * Edge resources for the CloudFront layout (production without a custom domain). CloudFront web
 * ACLs must live in us-east-1, so this small stack holds the WAF (same rules as the regional one),
 * its logs (Authorization/Cookie redacted) and the sign-in-blocks alarm with its own SNS topic
 * (alarms can only notify topics in their own region). The production stack attaches the ACL to its
 * distribution through `production:edgeWebAclArn` (output WebAclArn).
 */
export class EdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);
    Tags.of(this).add('app', 'dailytasks');
    Tags.of(this).add('environment', 'production-edge');
    const prefix = 'dailytasks-production-edge';

    const { acl, signInBlocks } = createWebAcl(this, {
      prefix,
      scope: 'CLOUDFRONT',
      allowedCidrs: props.allowedCidrs,
      rateLimit: props.wafRateLimit,
      authRateLimit: props.wafAuthRateLimit,
      logRetentionDays: props.logRetentionDays,
      retainLogs: true,
    });

    const topic = new sns.Topic(this, 'EdgeAlarmTopic', { displayName: `${prefix} alarms` });
    const emailError = props.alarmEmail ? validAlarmEmail(props.alarmEmail) : null;
    if (emailError) Annotations.of(this).addError(emailError);
    else if (props.alarmEmail) topic.addSubscription(new subs.EmailSubscription(props.alarmEmail));
    else Annotations.of(this).addWarning('No alarm e-mail configured: the edge alarm has no notification target (set ALARM_EMAIL and redeploy).');
    signInBlocksAlarm(this, signInBlocks).addAlarmAction(new cwActions.SnsAction(topic));

    new CfnOutput(this, 'WebAclArn', { value: acl.attrArn, description: 'Pass as production:edgeWebAclArn' });
  }
}
