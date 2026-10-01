#!/usr/bin/env node
// Runs automatically on `npm install` / `npm ci`. Gives a fresh clone the two
// things every later command assumes:
//   1. config/profile.mjs, seeded from the example (see ensure-profile.mjs)
//   2. the privacy pre-commit hook in .githooks/, which git ignores until
//      core.hooksPath points at it. That setting lives in .git/config, which a
//      clone never receives, so it has to be set here.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import './ensure-profile.mjs';

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

try {
  // Only when this directory is its own repository, never a parent one that
  // happens to contain it.
  if (realpathSync(git('rev-parse', '--show-toplevel')) === root) {
    git('config', 'core.hooksPath', '.githooks');
  }
} catch {
  // Not a git checkout (a ZIP download, say), or git is not installed.
}
