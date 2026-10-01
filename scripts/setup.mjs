#!/usr/bin/env node
// Stores your credentials as encrypted SSM SecureStrings, which is what the
// Lambda reads at runtime.
//
//   npm run setup            prompt for anything missing
//   npm run setup -- --force replace values that are already stored
//
// Input is read with the terminal echo off and goes straight from the prompt to
// the AWS API. Nothing is written to disk, so there is no file to leak later.
import { createInterface } from 'node:readline';
import { SSMClient, GetParametersCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

import { loadEnv, ssmPath, accountList } from './lib/env.mjs';

loadEnv();

const force = process.argv.includes('--force');
const region = process.env.AWS_REGION;
if (!region) {
  console.error('AWS_REGION is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const SECRETS = [
  {
    name: 'anthropic-api-key',
    label: 'Anthropic API key',
    help: 'https://console.anthropic.com/settings/keys — starts with sk-ant-',
    check: (v) => (v.startsWith('sk-ant-') ? null : 'That does not look like an Anthropic key (expected sk-ant-…).'),
  },
  {
    name: 'google-client-id',
    label: 'Google OAuth client ID',
    help: 'Google Cloud → Credentials → OAuth client ID → Desktop app',
    check: (v) =>
      v.endsWith('.apps.googleusercontent.com')
        ? null
        : 'That does not look like a client ID (expected …apps.googleusercontent.com).',
  },
  {
    name: 'google-client-secret',
    label: 'Google OAuth client secret',
    help: 'Shown next to the client ID. Usually starts with GOCSPX-',
    check: () => null,
  },
];

/**
 * Reads a line with the echo suppressed, so a pasted key never appears on
 * screen or in terminal scrollback. Prints the prompt itself, nothing typed.
 */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (text) => {
      if (text.includes(question)) rl.output.write(question);
    };
    // Without a listener, readline swallows Ctrl-C by pausing, and the pending
    // top-level await ends the process with an "unsettled" warning instead.
    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      process.exit(130);
    });
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

const ssm = new SSMClient({ region });

const stored = new Set(
  (
    await ssm.send(
      new GetParametersCommand({
        Names: SECRETS.map((s) => ssmPath(s.name)),
        WithDecryption: false,
      })
    )
  ).Parameters?.map((p) => p.Name) ?? []
);

console.log(`Storing secrets under ${ssmPath('')}* in ${region}.\n`);

let wrote = 0;
for (const secret of SECRETS) {
  const path = ssmPath(secret.name);

  if (stored.has(path) && !force) {
    console.log(`  ${secret.label}: already stored (--force to replace)`);
    continue;
  }

  console.log(`\n  ${secret.label}`);
  console.log(`  ${secret.help}`);

  // Allow a non-interactive override for CI, but never write it back anywhere.
  const envKey = secret.name.toUpperCase().replace(/-/g, '_');
  let value = (process.env[envKey] ?? '').trim();
  if (value) {
    // Said out loud, because a stale export in the shell would otherwise be
    // stored without anyone noticing it was not what they meant to paste.
    console.log(`  Using ${envKey} from your environment.`);
    const problem = secret.check(value);
    if (problem && !process.stdin.isTTY) {
      console.error(`  ${envKey}: ${problem}`);
      process.exit(1);
    }
    if (problem) {
      console.log(`  ${problem}`);
      console.log(`  Ignoring it and asking instead. Run \`unset ${envKey}\` to stop using it.`);
      value = '';
    }
  }

  while (!value) {
    value = await promptHidden('  paste it here (input hidden): ');
    if (!value) {
      console.log('  Nothing entered. Press Ctrl-C to quit.');
      continue;
    }
    const problem = secret.check(value);
    if (problem) {
      console.log(`  ${problem}`);
      value = '';
    }
  }

  await ssm.send(
    new PutParameterCommand({ Name: path, Value: value, Type: 'SecureString', Overwrite: true })
  );
  wrote++;
  console.log(`  Stored at ${path}`);
}

const accounts = accountList();
console.log(`
${wrote > 0 ? `Stored ${wrote} secret${wrote === 1 ? '' : 's'}.` : 'Nothing to store.'}

Next:
  ${accounts.map((a) => `npm run add-account ${a}`).join('\n  ')}
  npm run doctor
`);
