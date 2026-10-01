// Loads .env and derives the handful of values every script needs, so no script
// invents its own defaults and drifts from the others.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Reads .env into process.env. Existing variables win, so `VAR=x npm run …` overrides the file. */
export function loadEnv() {
  const file = join(ROOT, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
  // The AWS SDK resolves an empty AWS_PROFILE as a profile literally named "",
  // which fails confusingly. Treat blank as unset.
  for (const key of ['AWS_PROFILE', 'AWS_REGION']) {
    if (process.env[key] !== undefined && process.env[key].trim() === '') delete process.env[key];
  }
  return process.env;
}

/**
 * The accounts to scan, in .env order, de-duplicated. Unset or blank means
 * 'personal', the same default as accountNames() in src/ssm.mjs, which is what
 * the Lambda actually scans. Keep the two in step.
 */
export function accountList() {
  const names = [
    ...new Set(
      (process.env.ACCOUNTS ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
    ),
  ];
  return names.length > 0 ? names : ['personal'];
}

/** Full SSM parameter path for a name, honouring SSM_PREFIX. */
export function ssmPath(name) {
  const prefix = (process.env.SSM_PREFIX || '/gmail-digest').replace(/\/$/, '');
  return `${prefix}/${name}`;
}
