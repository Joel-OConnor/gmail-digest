#!/usr/bin/env node
// Checks every connection this tool needs, and says exactly what to do about
// whatever is broken. Safe to run at any point during setup: it reports what is
// missing rather than failing at the first gap.
//
//   npm run doctor
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { OAuth2Client } from 'google-auth-library';
import { gmail } from '@googleapis/gmail';
import Anthropic from '@anthropic-ai/sdk';

import { loadEnv, accountList, ssmPath } from './lib/env.mjs';

loadEnv();

const REQUIRED_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

let failures = 0;
let warnings = 0;

const ok = (label, detail = '') => console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`);
const warn = (label, fix) => {
  warnings++;
  console.log(`  warn  ${label}\n        ${fix}`);
};
const fail = (label, fix) => {
  failures++;
  console.log(`  FAIL  ${label}\n        ${fix}`);
};
const section = (name) => console.log(`\n${name}`);

// --- configuration -----------------------------------------------------------

section('Configuration');
const region = process.env.AWS_REGION;
const recipient = process.env.DIGEST_RECIPIENT;
const accounts = accountList();

if (!region) fail('AWS_REGION is not set', 'Add it to .env (see .env.example).');
else ok('AWS_REGION', region);

if (!recipient) {
  fail('DIGEST_RECIPIENT is not set', 'Add it to .env. This decides who receives your digest.');
} else if (!recipient.includes('@')) {
  fail(`DIGEST_RECIPIENT is not an email address: ${recipient}`, 'Fix it in .env.');
} else {
  ok('DIGEST_RECIPIENT', recipient);
}

// Unset is fine: the Lambda scans a single "personal" mailbox by default.
ok('ACCOUNTS', process.env.ACCOUNTS?.trim() ? accounts.join(', ') : 'personal (default)');

try {
  new Intl.DateTimeFormat('en-US', { timeZone: process.env.TIMEZONE || 'UTC' });
  ok('TIMEZONE', process.env.TIMEZONE || 'UTC (default)');
} catch {
  // Would otherwise throw deep in rendering, after the Claude bill is spent.
  fail(`TIMEZONE is not a valid IANA name: ${process.env.TIMEZONE}`, 'Use something like America/New_York.');
}

// --- profile -----------------------------------------------------------------

section('Profile');
try {
  const { PROFILE } = await import('../src/profile.mjs');
  const example = await import('../config/profile.example.mjs');
  ok('config/profile.mjs is valid');
  if (PROFILE.RUBRIC === example.RUBRIC) {
    warn(
      'Your profile is still the untouched example',
      'Run `npm run setup:profile` to build one from a short interview, or edit config/profile.mjs.'
    );
  }
} catch (err) {
  fail('config/profile.mjs is invalid', err.message.split('\n').join('\n        '));
}

// --- aws ---------------------------------------------------------------------

section('AWS');
let identity;
if (region) {
  try {
    identity = await new STSClient({ region }).send(new GetCallerIdentityCommand({}));
    // Print the account so nobody deploys into the wrong one by accident.
    ok('Credentials valid', `account ${identity.Account}, ${identity.Arn.split('/').pop()}`);
  } catch (err) {
    fail('AWS credentials are not usable', `${err.message}\n        Run: aws configure`);
  }
}

const secretNames = ['google-client-id', 'google-client-secret', 'anthropic-api-key'];
const secrets = {};
if (identity) {
  try {
    const ssm = new SSMClient({ region });
    const names = [
      ...secretNames.map((n) => ssmPath(n)),
      ...accounts.map((a) => ssmPath(`accounts/${a}/refresh-token`)),
      // Single-account installs predating per-account paths.
      ssmPath('google-refresh-token'),
    ];
    // GetParameters takes at most 10 names, which a handful of accounts exceeds.
    for (let i = 0; i < names.length; i += 10) {
      const res = await ssm.send(
        new GetParametersCommand({ Names: names.slice(i, i + 10), WithDecryption: true })
      );
      for (const p of res.Parameters ?? []) secrets[p.Name] = p.Value;
    }

    for (const name of secretNames) {
      if (secrets[ssmPath(name)]) ok(`SSM ${ssmPath(name)}`);
      else fail(`SSM ${ssmPath(name)} is missing`, 'Run: npm run setup');
    }
    for (const account of accounts) {
      if (secrets[ssmPath(`accounts/${account}/refresh-token`)]) {
        ok(`SSM token for "${account}"`);
      } else if (accounts.length === 1 && secrets[ssmPath('google-refresh-token')]) {
        ok(`SSM token for "${account}"`, 'at the legacy single-account path');
      } else {
        fail(`No refresh token for account "${account}"`, `Run: npm run add-account ${account}`);
      }
    }
  } catch (err) {
    fail('Cannot read SSM parameters', `${err.message}\n        Check the region and your IAM permissions.`);
  }

  try {
    const lambda = new LambdaClient({ region });
    const fn = await lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: process.env.FUNCTION_NAME || 'gmail-digest' })
    );
    ok('Lambda exists', `${fn.FunctionName}, ${fn.Runtime}, ${fn.MemorySize}MB, ${fn.Timeout}s`);
  } catch (err) {
    if (err?.name === 'ResourceNotFoundException') {
      warn(
        'The Lambda does not exist yet',
        'Run `npm run bootstrap` to create it. Local dry runs work without it.'
      );
    } else {
      fail('Cannot read the Lambda configuration', `${err.message}\n        Check the region and your IAM permissions.`);
    }
  }
}

// --- gmail -------------------------------------------------------------------

section('Gmail');
const clientId = secrets[ssmPath('google-client-id')];
const clientSecret = secrets[ssmPath('google-client-secret')];

for (const account of accounts) {
  const refreshToken =
    secrets[ssmPath(`accounts/${account}/refresh-token`)] ??
    (accounts.length === 1 ? secrets[ssmPath('google-refresh-token')] : undefined);
  if (!clientId || !clientSecret || !refreshToken) continue;

  try {
    const auth = new OAuth2Client(clientId, clientSecret);
    auth.setCredentials({ refresh_token: refreshToken });

    // Refreshing is the only way to catch a revoked or expired token.
    const { token } = await auth.getAccessToken();
    const info = await auth.getTokenInfo(token);
    const missing = REQUIRED_SCOPES.filter((s) => !info.scopes.includes(s));

    // Which mailbox the token actually belongs to. Consenting as the wrong
    // Google account is easy and otherwise invisible until the digest arrives
    // full of someone else's mail.
    const profile = await gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' });

    if (missing.length > 0) {
      fail(
        `"${account}" (${profile.data.emailAddress}) is missing scopes: ${missing.join(', ')}`,
        `Run: npm run add-account ${account} — and tick every permission checkbox.`
      );
    } else {
      ok(`"${account}"`, `${profile.data.emailAddress}, both scopes granted`);
    }
  } catch (err) {
    const hint = /invalid_grant/i.test(err.message)
      ? 'The token was revoked (a Google password change does this).'
      : err.message;
    fail(`"${account}" token is not usable`, `${hint}\n        Run: npm run add-account ${account}`);
  }
}

// --- anthropic ---------------------------------------------------------------

section('Claude');
const apiKey = secrets[ssmPath('anthropic-api-key')];
const model = process.env.MODEL || 'claude-sonnet-4-6';

if (apiKey) {
  const client = new Anthropic({ apiKey, maxRetries: 0 });
  const probe = (extra) =>
    client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
      ...extra,
    });

  try {
    await probe({});
    ok('API key and model', model);

    // Second probe on purpose: newer models reject temperature outright, and
    // one combined probe cannot tell that apart from a billing problem.
    try {
      await probe({ temperature: 0 });
      ok('Model accepts temperature: 0');
    } catch (err) {
      if (err?.status === 400) {
        warn(
          `${model} rejects temperature: 0`,
          'Informational — the digest omits temperature unless you set TEMPERATURE in .env.'
        );
      } else {
        warn('Could not verify temperature handling', err.message);
      }
    }
  } catch (err) {
    if (err?.status === 401) fail('Anthropic API key is invalid', 'Run: npm run setup -- --force');
    else if (err?.status === 404) fail(`Model "${model}" does not exist`, 'Fix MODEL in .env.');
    else if (err?.error?.error?.type === 'billing_error' || /credit/i.test(err.message)) {
      fail('Anthropic account has no credit', 'Add credit at console.anthropic.com/settings/billing.');
    } else fail('Anthropic API call failed', err.message);
  }
}

// --- verdict -----------------------------------------------------------------

console.log('');
if (failures > 0) {
  console.log(`${failures} problem${failures === 1 ? '' : 's'} to fix${warnings ? `, ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`);
  process.exit(1);
}
console.log(
  warnings > 0
    ? `Ready, with ${warnings} warning${warnings === 1 ? '' : 's'}. Next: DRY_RUN=true npm run preview`
    : 'Everything checks out. Next: DRY_RUN=true npm run preview'
);
