#!/usr/bin/env node
// Creates (or updates) everything this tool needs in your AWS account:
// the Lambda execution role and its permissions, the function itself, a log
// retention policy, the scheduler's role, and the twice-daily schedule.
//
// Safe to re-run. Every step checks first and updates in place, so this is also
// how you change the schedule:
//   CRON='cron(0 7,12,17 * * ? *)' npm run bootstrap
// A re-run without CRON keeps whatever schedule is already deployed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  AttachRolePolicyCommand,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import {
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';
import {
  CloudWatchLogsClient,
  CreateLogGroupCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  SchedulerClient,
  CreateScheduleCommand,
  GetScheduleCommand,
  UpdateScheduleCommand,
} from '@aws-sdk/client-scheduler';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { KMSClient, DescribeKeyCommand } from '@aws-sdk/client-kms';

import { loadEnv, ssmPath, ROOT } from './lib/env.mjs';

loadEnv();

const region = process.env.AWS_REGION;
if (!region) {
  console.error('AWS_REGION is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const fnName = process.env.FUNCTION_NAME || 'gmail-digest';
const timezone = process.env.TIMEZONE || 'UTC';
const DEFAULT_CRON = 'cron(0 10,16 * * ? *)';
const retentionDays = Number(process.env.LOG_RETENTION_DAYS || 14);
const execRole = `${fnName}-lambda`;
const schedulerRole = `${fnName}-scheduler`;
const prefix = ssmPath('').replace(/\/$/, '');

const iam = new IAMClient({ region });
const lambda = new LambdaClient({ region });
const logs = new CloudWatchLogsClient({ region });
const scheduler = new SchedulerClient({ region });

const step = (msg) => console.log(`\n▸ ${msg}`);
const done = (msg) => console.log(`  ${msg}`);

// IAM is eventually consistent: a role is not immediately assumable by the
// service that needs it, and both Lambda and Scheduler validate that at
// create time. Retry rather than making the user re-run the script.
//
// Only those two exact complaints are retried. Anything broader also catches
// a caller's own AccessDenied or a bad CRON/TIMEZONE, and then spends a minute
// blaming IAM propagation for a mistake that will never fix itself.
const isPropagationError = (err) =>
  (err?.name === 'InvalidParameterValueException' && /cannot be assumed/i.test(err.message)) ||
  (err?.name === 'ValidationException' && /execution role.*assume/i.test(err.message));

async function withPropagationRetry(label, fn, attempts = 6) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isPropagationError(err) || attempt === attempts) throw err;
      done(`${label} not ready yet (IAM propagation); retrying in 10s…`);
      await new Promise((r) => {
        setTimeout(r, 10_000);
      });
    }
  }
}

// Returns null when the resource is absent, instead of throwing.
const exists = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (/NoSuchEntity|ResourceNotFound/i.test(err.name + err.message)) return null;
    throw err;
  }
};

// For create calls that are fine to repeat.
const ignoreAlreadyExists = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (/AlreadyExists/i.test(err.name + err.message)) return null;
    throw err;
  }
};

// --- identity ----------------------------------------------------------------

const { Account: accountId } = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
console.log(`Bootstrapping "${fnName}" in ${region}, AWS account ${accountId}.`);

// --- execution role ----------------------------------------------------------

step(`Lambda execution role: ${execRole}`);
let roleArn = (await exists(() => iam.send(new GetRoleCommand({ RoleName: execRole }))))?.Role?.Arn;

if (roleArn) {
  done('Already exists.');
} else {
  const created = await iam.send(
    new CreateRoleCommand({
      RoleName: execRole,
      Description: `Execution role for the ${fnName} inbox digest`,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      }),
    })
  );
  roleArn = created.Role.Arn;
  done('Created.');
}

await iam.send(
  new AttachRolePolicyCommand({
    RoleName: execRole,
    PolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
  })
);
done('CloudWatch Logs permission attached.');

// SecureString parameters are encrypted with the account's default SSM key, and
// IAM needs its ARN rather than the alias.
const ssmKeyArn = (
  await new KMSClient({ region }).send(new DescribeKeyCommand({ KeyId: 'alias/aws/ssm' }))
).KeyMetadata.Arn;

await iam.send(
  new PutRolePolicyCommand({
    RoleName: execRole,
    PolicyName: `${fnName}-ssm`,
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['ssm:GetParameter', 'ssm:GetParameters'],
          // Scoped to this install's prefix, so two copies in one AWS account
          // cannot read each other's tokens.
          Resource: `arn:aws:ssm:${region}:${accountId}:parameter${prefix}/*`,
        },
        {
          Effect: 'Allow',
          Action: 'ssm:PutParameter',
          // The checkpoint is the only thing the function writes. Anything wider
          // would let a compromised run overwrite the secrets it reads.
          Resource: `arn:aws:ssm:${region}:${accountId}:parameter${prefix}/checkpoint`,
        },
        { Effect: 'Allow', Action: 'kms:Decrypt', Resource: ssmKeyArn },
      ],
    }),
  })
);
done(`SSM read access scoped to ${prefix}/*, write access to ${prefix}/checkpoint only.`);

// --- function ----------------------------------------------------------------

step(`Lambda function: ${fnName}`);
const existing = await exists(() =>
  lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fnName }))
);

if (existing) {
  done('Already exists — run `npm run deploy` to push code and settings.');
} else {
  const zipPath = join(ROOT, 'dist', 'function.zip');
  let zip;
  try {
    zip = readFileSync(zipPath);
  } catch {
    console.error(`\nNo build found at dist/function.zip. Run: npm run build && npm run zip`);
    process.exit(1);
  }

  await withPropagationRetry('Role', () =>
    lambda.send(
      new CreateFunctionCommand({
        FunctionName: fnName,
        Runtime: 'nodejs22.x',
        Architectures: ['arm64'],
        MemorySize: 512,
        Timeout: 600,
        Handler: 'index.handler',
        Role: roleArn,
        Code: { ZipFile: zip },
        Description: 'Classifies new mail with Claude and emails a digest',
      })
    )
  );
  done('Created. Run `npm run deploy` to apply your .env settings.');
}

// --- log retention -----------------------------------------------------------

step('CloudWatch log retention');
const logGroup = `/aws/lambda/${fnName}`;
await ignoreAlreadyExists(() => logs.send(new CreateLogGroupCommand({ logGroupName: logGroup })));
await logs.send(
  new PutRetentionPolicyCommand({ logGroupName: logGroup, retentionInDays: retentionDays })
);
// Logs never contain mail content in the Lambda, but they do record when and
// how much mail arrived, and unbounded retention is a needless cost and privacy tail.
done(`${logGroup} kept for ${retentionDays} days.`);

// --- scheduler ---------------------------------------------------------------

step(`Scheduler role: ${schedulerRole}`);
if (await exists(() => iam.send(new GetRoleCommand({ RoleName: schedulerRole })))) {
  done('Already exists.');
} else {
  await iam.send(
    new CreateRoleCommand({
      RoleName: schedulerRole,
      Description: `Lets EventBridge Scheduler invoke ${fnName}`,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          { Effect: 'Allow', Principal: { Service: 'scheduler.amazonaws.com' }, Action: 'sts:AssumeRole' },
        ],
      }),
    })
  );
  done('Created.');
}

const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${fnName}`;
await iam.send(
  new PutRolePolicyCommand({
    RoleName: schedulerRole,
    PolicyName: `invoke-${fnName}`,
    PolicyDocument: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'lambda:InvokeFunction', Resource: functionArn }],
    }),
  })
);
done('Invoke permission attached.');

const current = await exists(() => scheduler.send(new GetScheduleCommand({ Name: fnName })));
// An explicit CRON wins, then the schedule already deployed, so re-running
// bootstrap for some other reason never resets a schedule you customised.
const cron = process.env.CRON || current?.ScheduleExpression || DEFAULT_CRON;

step(`Schedule: ${cron} (${timezone})`);
const target = {
  Arn: functionArn,
  RoleArn: `arn:aws:iam::${accountId}:role/${schedulerRole}`,
  // The schedule passes its own fire time, which is what makes a retry of an
  // already-digested window a no-op. See ARCHITECTURE.md.
  Input: JSON.stringify({ scheduledTime: '<aws.scheduler.scheduled-time>' }),
  RetryPolicy: { MaximumRetryAttempts: 1 },
};
const schedule = {
  Name: fnName,
  ScheduleExpression: cron,
  ScheduleExpressionTimezone: timezone,
  FlexibleTimeWindow: { Mode: 'OFF' },
  Target: target,
};

if (current) {
  // Preserve enabled/disabled: an update that omits State silently re-enables a
  // schedule someone deliberately paused.
  await scheduler.send(new UpdateScheduleCommand({ ...schedule, State: current.State }));
  done(`Updated in place (state: ${current.State}).`);
} else {
  await withPropagationRetry('Scheduler role', () =>
    scheduler.send(new CreateScheduleCommand(schedule))
  );
  done('Created and enabled.');
}

console.log(`
Done. Next:
  npm run doctor          verify every connection
  npm run deploy          push code and your .env settings
  DRY_RUN=true npm run preview    see a digest without sending one
`);
