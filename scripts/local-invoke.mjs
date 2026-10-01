#!/usr/bin/env node
// Runs the real handler locally against your real inbox, reading settings from
// .env. Defaults to a dry run: it prints the digest, sends nothing, and leaves
// the checkpoint alone.
//
//   DRY_RUN=true  npm run preview    preview only (the default)
//   DRY_RUN=false npm run preview    really send, and advance the checkpoint
//
// Needs AWS credentials that can read your SSM parameters.
import { loadEnv } from './lib/env.mjs';

loadEnv();

// Dry by default here, unlike the Lambda: the whole point of running locally is
// to look before you send. Only an exact DRY_RUN=false sends, because the
// handler treats anything but 'true' as live, and a blank or mistyped value
// (DRY_RUN=, DRY_RUN=1) should not mail a real digest and move the checkpoint.
process.env.DRY_RUN = process.env.DRY_RUN === 'false' ? 'false' : 'true';

if (!process.env.DIGEST_RECIPIENT) {
  console.error('DIGEST_RECIPIENT is not set. Put it in .env (see .env.example).');
  process.exit(1);
}
if (!process.env.AWS_REGION) {
  console.error('AWS_REGION is not set. Put it in .env (see .env.example).');
  process.exit(1);
}

if (process.env.DRY_RUN !== 'true') {
  console.log(`Sending a real digest to ${process.env.DIGEST_RECIPIENT}…\n`);
}

const { handler } = await import('../src/handler.mjs');
const result = await handler();
console.log(`\nResult: ${JSON.stringify(result)}`);
