import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { validateProfile, REQUIRED_TEXT } from '../src/validate-profile.mjs';

// Guards the one property that matters once this repo is public: nothing
// tracked by git contains personal data or credentials.
//
// The deny-list is derived from the gitignored .env and profile at runtime, so
// this test file itself carries no personal data and stays useful for whoever
// clones it next.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

const read = (file) => {
  try {
    return readFileSync(join(root, file), 'utf8');
  } catch {
    return ''; // deleted-but-staged, or unreadable binary
  }
};

const readStaged = (file) => {
  try {
    return git('show', `:${file}`);
  } catch {
    return ''; // mid-merge, with no single staged copy
  }
};

/**
 * [path, content] for every tracked file, or null when this copy is not its
 * own git checkout (a ZIP download, a git archive).
 */
const tracked = () => {
  try {
    // A non-empty prefix means some enclosing repo, whose file list says nothing about this one.
    if (git('rev-parse', '--show-prefix').trim() !== '') return null;
  } catch {
    return null;
  }
  // The hook runs this to vouch for what is being committed, which is the
  // index. A leak that is staged and then cleaned in the working tree only
  // shows in the staged copy, so read that too wherever the two differ.
  const differs = new Set(git('diff', '--name-only', '-z').split('\0').filter(Boolean));
  return git('ls-files', '-z')
    .split('\0')
    .filter(Boolean)
    .map((file) => [file, differs.has(file) ? `${read(file)}\n${readStaged(file)}` : read(file)]);
};

// Credential shapes, checked regardless of whose machine this runs on.
// .githooks/pre-commit greps staged lines for the same shapes; keep them in step.
const SECRET_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/GOCSPX-[A-Za-z0-9_-]{10,}/, 'a Google client secret'],
  [/\b1\/\/[A-Za-z0-9_-]{20,}/, 'a Google refresh token'],
  [/\b\d{12}\b/, 'an AWS account id'],
];

test('no tracked file contains a credential', (t) => {
  const files = tracked();
  if (!files) {
    t.skip('not a git checkout');
    return;
  }

  const offenders = [];
  for (const [file, content] of files) {
    for (const [pattern, what] of SECRET_PATTERNS) {
      if (pattern.test(content)) offenders.push(`${file} looks like it contains ${what}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// Keys whose values identify the user or authenticate as them. Everything else
// in .env (model name, region, function name, account labels) is a shared
// default that legitimately appears in tracked files.
const PROTECTED_KEYS = [
  'DIGEST_RECIPIENT',
  'ANTHROPIC_API_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];

test('no tracked file contains a protected value from the local .env', (t) => {
  const files = tracked();
  if (!files) {
    t.skip('not a git checkout');
    return;
  }
  const envPath = join(root, '.env');
  if (!existsSync(envPath)) {
    t.skip('no .env, so nothing personal to look for');
    return;
  }

  // parseEnv reads quotes and `export` prefixes the way process.loadEnvFile does,
  // so the value compared is the value the scripts actually use.
  const env = parseEnv(readFileSync(envPath, 'utf8'));
  // A placeholder left as copied is not personal, and the docs quote it.
  const example = parseEnv(readFileSync(join(root, '.env.example'), 'utf8'));
  const values = PROTECTED_KEYS.filter((key) => typeof env[key] === 'string' && env[key] !== example[key])
    .map((key) => env[key].trim())
    .filter((value) => value.length >= 8);

  const offenders = [];
  for (const [file, content] of files) {
    if (file === '.env.example') continue;
    for (const value of values) {
      if (content.includes(value)) offenders.push(`${file} contains a value from .env`);
    }
  }
  assert.deepEqual([...new Set(offenders)], []);
});

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

test('no tracked file contains text from the local profile', async (t) => {
  const files = tracked();
  if (!files) {
    t.skip('not a git checkout');
    return;
  }
  const profilePath = join(root, 'config', 'profile.mjs');
  if (!existsSync(profilePath)) {
    t.skip('no config/profile.mjs, so nothing personal to look for');
    return;
  }

  // The exported values, not the source lines: the source has a generated
  // comment header that tracked files legitimately share, and a whole rubric
  // can sit on one long string literal line.
  const [profile, example] = await Promise.all([
    import(pathToFileURL(profilePath).href),
    import(pathToFileURL(join(root, 'config', 'profile.example.mjs')).href),
  ]);
  const texts = (p) => REQUIRED_TEXT.map((key) => p[key]).filter((value) => typeof value === 'string');
  const muted = (p) => (Array.isArray(p.MUTED_SENDERS) ? p.MUTED_SENDERS.map(String) : []);
  const exampleText = [...texts(example), ...muted(example)].join('\n');

  // Distinctive sentences and lines only: single words collide with prose.
  const fragments = texts(profile)
    .flatMap((text) => text.split(/\n|(?<=[.!?])\s+/))
    .map((fragment) => fragment.replace(/^[\s*#>-]+/, '').trim())
    .filter(
      (fragment) =>
        fragment.length >= 40 && fragment.split(/\s+/).length >= 6 && !exampleText.includes(fragment)
    );
  const emails = [...texts(profile), ...muted(profile)]
    .flatMap((text) => text.match(EMAIL) ?? [])
    .map((email) => email.toLowerCase())
    .filter((email) => !exampleText.toLowerCase().includes(email));

  if (fragments.length === 0 && emails.length === 0) {
    t.skip('profile has nothing beyond the example, so nothing personal to look for');
    return;
  }

  // Name the file only: this output lands in terminals and CI logs.
  const offenders = [];
  for (const [file, content] of files) {
    if (fragments.some((fragment) => content.includes(fragment))) {
      offenders.push(`${file} contains text from your profile`);
    }
    const lower = content.toLowerCase();
    if (emails.some((email) => lower.includes(email))) {
      offenders.push(`${file} contains an email address from your profile`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the profile and its example expose exactly the same exports', async () => {
  // Drift here means a fresh clone gets a profile the loader rejects.
  const [example, fixture] = await Promise.all([
    import('../config/profile.example.mjs'),
    import('./fixtures/profile.fixture.mjs'),
  ]);
  assert.deepEqual(Object.keys(example).sort(), Object.keys(fixture).sort());
});

test('the example profile passes validation', async () => {
  const example = await import('../config/profile.example.mjs');
  assert.doesNotThrow(() => validateProfile(example));
});
