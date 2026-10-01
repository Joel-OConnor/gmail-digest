#!/usr/bin/env node
// Bundles the code, uploads it, and applies your settings to the Lambda.
//
//   npm run deploy                        push code and the settings in .env
//   MIN_IMPORTANCE=high npm run deploy    override one setting for this run
//
// Config precedence, per variable: explicit env var > .env > value already
// deployed > default. That ordering matters — a bare `npm run deploy` must
// never silently revert a setting you tuned (it did once, resetting SCAN_SCOPE
// and MIN_IMPORTANCE and producing a wrong digest). DRY_RUN and TEMPERATURE
// skip the deployed step, see below.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  LambdaClient,
  GetFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdatedV2,
} from '@aws-sdk/client-lambda';

import { loadEnv, ROOT } from './lib/env.mjs';

// Captured before .env is loaded, so an explicit `VAR=x npm run deploy` can be
// told apart from the same value sitting in .env.
const explicit = { ...process.env };
loadEnv();

const region = process.env.AWS_REGION;
if (!region) {
  console.error('AWS_REGION is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const fnName = process.env.FUNCTION_NAME || 'gmail-digest';
const lambda = new LambdaClient({ region });

let deployed = {};
try {
  const current = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fnName }));
  deployed = current.Environment?.Variables ?? {};
} catch (err) {
  if (err?.name === 'ResourceNotFoundException') {
    console.error(`\nNo Lambda named "${fnName}" in ${region}. Run: npm run bootstrap\n`);
  } else {
    console.error(`\nCould not read the "${fnName}" Lambda in ${region}: ${err.message}`);
    console.error('Run `npm run doctor` to see what is wrong.\n');
  }
  process.exit(1);
}

/** Explicit env var, then .env, then what is already deployed, then the default. */
const resolve = (name, fallback) =>
  explicit[name] ?? process.env[name] ?? deployed[name] ?? fallback;

// DRY_RUN and TEMPERATURE never inherit the deployed value. A one-off
// `DRY_RUN=true npm run deploy` would otherwise stay on through every later
// deploy, and a TEMPERATURE deleted from .env would stay set too (newer models
// 400 on it). process.env already holds the explicit value over .env.
const fromEnvOnly = (name, fallback) => process.env[name] ?? fallback;

// Every setting the handler reads. Anything absent here would silently fall
// back to the handler's own default, so the list is the contract.
const settings = {
  DIGEST_RECIPIENT: resolve('DIGEST_RECIPIENT', ''),
  ACCOUNTS: resolve('ACCOUNTS', 'personal'),
  MODEL: resolve('MODEL', 'claude-sonnet-4-6'),
  TIMEZONE: resolve('TIMEZONE', 'UTC'),
  MIN_IMPORTANCE: resolve('MIN_IMPORTANCE', 'medium'),
  SCAN_SCOPE: resolve('SCAN_SCOPE', 'inbox'),
  MAX_EMAILS: resolve('MAX_EMAILS', '100'),
  SSM_PREFIX: resolve('SSM_PREFIX', '/gmail-digest'),
  DRY_RUN: fromEnvOnly('DRY_RUN', 'false'),
};

// Optional: only sent when set, because newer models 400 on an explicit value.
const temperature = fromEnvOnly('TEMPERATURE', '');
if (temperature) settings.TEMPERATURE = temperature;

if (!settings.DIGEST_RECIPIENT) {
  console.error('\nDIGEST_RECIPIENT is not set. Put it in .env (see .env.example).');
  console.error('Never leave it unset: it decides who receives your inbox summary.\n');
  process.exit(1);
}

if (settings.DRY_RUN === 'true') {
  // A scheduled dry run sends nothing and never advances the checkpoint, and
  // inside Lambda it logs the subject line only, so the digest is not kept
  // anywhere. Easy to leave on by accident.
  console.warn('\n⚠  DRY_RUN=true — the deployed function will not send anything.\n');
}

console.log(`Deploying ${fnName} to ${region}`);
for (const [key, value] of Object.entries(settings)) console.log(`  ${key}=${value}`);

// --- build -------------------------------------------------------------------

console.log('\nBuilding bundle…');
const npm = (...args) => execFileSync('npm', ['run', ...args], { cwd: ROOT, stdio: 'inherit' });
npm('build');
npm('zip');

// --- upload ------------------------------------------------------------------

console.log(`\nUploading code…`);
const code = await lambda.send(
  new UpdateFunctionCodeCommand({
    FunctionName: fnName,
    ZipFile: readFileSync(join(ROOT, 'dist', 'function.zip')),
  })
);
console.log(`  ${code.CodeSha256}`);
await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: fnName });

console.log('Applying configuration…');
await lambda.send(
  new UpdateFunctionConfigurationCommand({
    FunctionName: fnName,
    Handler: 'index.handler',
    Timeout: 600,
    MemorySize: 512,
    Environment: { Variables: settings },
  })
);
await waitUntilFunctionUpdatedV2({ client: lambda, maxWaitTime: 120 }, { FunctionName: fnName });

console.log(`\nDeployed ${fnName} in ${region}.`);
