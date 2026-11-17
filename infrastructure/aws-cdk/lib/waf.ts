import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';

export interface WafOptions {
  /** Name prefix, e.g. dailytasks-production. */
  prefix: string;
  /** REGIONAL (ALB, custom-domain mode) or CLOUDFRONT (edge stack in us-east-1). */
  scope: 'REGIONAL' | 'CLOUDFRONT';
  /** Optional IP allow-list (CIDRs, comma-separated): every other source IP is blocked. */
  allowedCidrs?: string;
  /** Requests per source IP per 5 minutes (all requests / sign-in endpoints). */
  rateLimit?: number;
  authRateLimit?: number;
  logRetentionDays: number;
  retainLogs: boolean;
}

/**
 * Web ACL shared by both edge layouts: IP reputation, known bad inputs, core rule set (two body
 * rules COUNT-only), sign-in rate limit and a global rate limit per source IP, optional IP
 * allow-list; logs with `Authorization`/`Cookie` redacted. Returns the ACL and the metric of
 * requests blocked by the sign-in rate limit (for an alarm in the same region).
 */
export function createWebAcl(scope: Construct, o: WafOptions): { acl: wafv2.CfnWebACL; signInBlocks: cloudwatch.Metric } {
  const stack = Stack.of(scope);
  const visibility = (name: string): wafv2.CfnWebACL.VisibilityConfigProperty => ({ cloudWatchMetricsEnabled: true, sampledRequestsEnabled: true, metricName: `${o.prefix}-${name}` });
  const managed = (priority: number, name: string, overrides: string[] = []): wafv2.CfnWebACL.RuleProperty => ({
    name,
    priority,
    overrideAction: { none: {} },
    statement: {
      managedRuleGroupStatement: {
        vendorName: 'AWS',
        name,
        ...(overrides.length ? { ruleActionOverrides: overrides.map((r) => ({ name: r, actionToUse: { count: {} } })) } : {}),
      },
    },
    visibilityConfig: visibility(name),
  });
  const startsWith = (path: string): wafv2.CfnWebACL.StatementProperty => ({
    byteMatchStatement: { fieldToMatch: { uriPath: {} }, positionalConstraint: 'STARTS_WITH', searchString: path, textTransformations: [{ priority: 0, type: 'NONE' }] },
  });
  const rules: wafv2.CfnWebACL.RuleProperty[] = [];
  const cidrs = (o.allowedCidrs ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (cidrs.length) {
    const ipSet = new wafv2.CfnIPSet(scope, 'AllowedIps', { scope: o.scope, ipAddressVersion: 'IPV4', addresses: cidrs, description: `${o.prefix} acceptance IP allow-list` });
    rules.push({
      name: 'block-outside-allowlist',
      priority: 0,
      action: { block: {} },
      statement: { notStatement: { statement: { ipSetReferenceStatement: { arn: ipSet.attrArn } } } },
      visibilityConfig: visibility('ip-allowlist'),
    });
  }
  rules.push(
    managed(1, 'AWSManagedRulesAmazonIpReputationList'),
    managed(2, 'AWSManagedRulesKnownBadInputsRuleSet'),
    // Uploads go straight to S3, but JSON bodies (comments, reports) can be legitimately large or
    // contain markup-like text; those two rules only COUNT (the app escapes all output).
    managed(3, 'AWSManagedRulesCommonRuleSet', ['SizeRestrictions_BODY', 'CrossSiteScripting_BODY']),
    {
      name: 'rate-limit-sign-in',
      priority: 10,
      action: { block: {} },
      statement: {
        rateBasedStatement: {
          limit: o.authRateLimit ?? 200,
          evaluationWindowSec: 300,
          aggregateKeyType: 'IP',
          scopeDownStatement: { orStatement: { statements: [startsWith('/api/v1/auth/'), startsWith('/session/')] } },
        },
      },
      visibilityConfig: visibility('rate-sign-in'),
    },
    {
      name: 'rate-limit-all',
      priority: 11,
      action: { block: {} },
      statement: { rateBasedStatement: { limit: o.rateLimit ?? 6000, evaluationWindowSec: 300, aggregateKeyType: 'IP' } },
      visibilityConfig: visibility('rate-all'),
    },
  );
  const acl = new wafv2.CfnWebACL(scope, 'WebAcl', { name: o.prefix, scope: o.scope, defaultAction: { allow: {} }, rules, visibilityConfig: visibility('acl') });
  // WAF logs: bearer tokens and session cookies are redacted (never stored in logs).
  const wafLogs = new logs.LogGroup(scope, 'WafLogs', {
    logGroupName: `aws-waf-logs-${o.prefix}`,
    retention: o.logRetentionDays as logs.RetentionDays,
    removalPolicy: o.retainLogs ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
  });
  new wafv2.CfnLoggingConfiguration(scope, 'WafLogging', {
    resourceArn: acl.attrArn,
    logDestinationConfigs: [`arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:${wafLogs.logGroupName}`],
    redactedFields: [{ singleHeader: { Name: 'authorization' } }, { singleHeader: { Name: 'cookie' } }],
  }).node.addDependency(wafLogs);
  // CloudFront web ACL metrics carry no Region dimension (they live in us-east-1).
  const signInBlocks = new cloudwatch.Metric({
    namespace: 'AWS/WAFV2',
    metricName: 'BlockedRequests',
    dimensionsMap: o.scope === 'CLOUDFRONT' ? { WebACL: o.prefix, Rule: `${o.prefix}-rate-sign-in` } : { WebACL: o.prefix, Region: stack.region, Rule: `${o.prefix}-rate-sign-in` },
    statistic: 'Sum',
    period: Duration.minutes(5),
  });
  return { acl, signInBlocks };
}

/** Alarm on the sign-in rate limit blocking requests. */
export function signInBlocksAlarm(scope: Construct, metric: cloudwatch.Metric): cloudwatch.Alarm {
  return new cloudwatch.Alarm(scope, 'WafSignInBlocksAlarm', {
    metric,
    threshold: 50,
    evaluationPeriods: 1,
    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    alarmDescription: 'Sign-in rate limit is blocking requests (password guessing, or an office NAT needs a higher limit)',
  });
}
