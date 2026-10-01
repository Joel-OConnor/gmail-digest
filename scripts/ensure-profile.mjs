#!/usr/bin/env node
// A fresh clone has no config/profile.mjs (it is gitignored), which would make
// the build fail with an opaque esbuild resolution error. Seed it from the
// example instead, so `npm test` and `npm run build` work immediately and the
// user edits a real file rather than creating one.
//
//   node scripts/ensure-profile.mjs           seed it if missing
//   node scripts/ensure-profile.mjs --check   ...then fail if it is invalid
//
// The build runs with --check: esbuild never executes the profile, so without
// it an invalid profile would bundle cleanly and fail every Lambda cold start.
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = join(root, 'config', 'profile.mjs');

if (!existsSync(profile)) {
  copyFileSync(join(root, 'config', 'profile.example.mjs'), profile);
  console.log('Created config/profile.mjs from the example.');
  console.log('Edit it, or run `npm run setup:profile` to build one by interview.');
}

if (process.argv.includes('--check')) {
  const { validateProfile } = await import('../src/validate-profile.mjs');
  try {
    validateProfile(await import(pathToFileURL(profile).href));
  } catch (err) {
    console.error(`\nconfig/profile.mjs: ${err.message}\n`);
    process.exit(1);
  }
}
