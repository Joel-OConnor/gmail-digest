import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/* eslint-disable no-template-curly-in-string -- these strings contain template
   syntax on purpose: they are the input being tested, not interpolation this
   file wants to perform. */
import { renderProfile } from '../scripts/lib/render-profile.mjs';
import { validateProfile } from '../src/profile.mjs';

// `npm run setup:profile` writes a module built from model output. These tests
// pin the property that makes that safe: the output is embedded as data, so
// text that looks like code stays text.

const base = {
  ABOUT_YOU: 'I do things.',
  RUBRIC: 'HIGH: urgent. MEDIUM: soon. LOW: noise.',
  MUTED_SENDERS: ['noise@example.com'],
  VOICE: 'Be brief.',
  REPLY_STYLE: 'Be warm.',
};

// One scratch dir for the whole file, removed when the run ends. Each module
// needs its own filename because the import cache is keyed on the path.
const scratch = mkdtempSync(join(tmpdir(), 'digest-profile-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;

/** Writes the rendered module to a temp dir and imports it, as the real flow does. */
function roundTrip(profile) {
  const file = join(scratch, `profile-${seq++}.mjs`);
  writeFileSync(file, renderProfile(profile));
  return import(pathToFileURL(file).href);
}

test('a plain profile round-trips through the generated module', async () => {
  const loaded = await roundTrip(base);
  assert.equal(loaded.ABOUT_YOU, base.ABOUT_YOU);
  assert.equal(loaded.VOICE, base.VOICE);
  assert.deepEqual(loaded.MUTED_SENDERS, base.MUTED_SENDERS);
  assert.doesNotThrow(() => validateProfile(loaded));
});

test('a ${ABOUT_YOU} token in the rubric stays literal text', async () => {
  // The classifier gets ABOUT_YOU in its own section, so nothing is substituted.
  const rubric = 'HIGH: urgent. MEDIUM: soon. LOW: noise.\n\n${ABOUT_YOU}';
  const loaded = await roundTrip({ ...base, RUBRIC: rubric });
  assert.equal(loaded.RUBRIC, rubric);
});

test('quotes, backslashes, newlines, and backticks survive intact', async () => {
  const nasty = `He said "hi" and 'bye'\\then a backtick \` and a newline\nplus a $ sign`;
  const loaded = await roundTrip({ ...base, VOICE: nasty });
  assert.equal(loaded.VOICE, nasty);
});

test('output that looks like code becomes a string, not code', async () => {
  // The whole point: a model returning this must not get it executed.
  const attack = '"; globalThis.PWNED = true; const x = "';
  const loaded = await roundTrip({ ...base, ABOUT_YOU: attack });
  assert.equal(loaded.ABOUT_YOU, attack, 'stored verbatim as text');
  assert.equal(globalThis.PWNED, undefined, 'nothing from the profile was executed');
});

test('any other template expression is left as literal text', async () => {
  const loaded = await roundTrip({ ...base, VOICE: 'cost is ${process.env.SECRET} today' });
  assert.equal(loaded.VOICE, 'cost is ${process.env.SECRET} today');
});

test('a comment-closing sequence cannot escape into the module body', async () => {
  const loaded = await roundTrip({ ...base, REPLY_STYLE: '*/ globalThis.ESCAPED = true; /*' });
  assert.equal(loaded.REPLY_STYLE, '*/ globalThis.ESCAPED = true; /*');
  assert.equal(globalThis.ESCAPED, undefined);
});

test('muted senders render as a real array, whatever they contain', async () => {
  const senders = ['a@x.com', "b'quote@x.com", 'c"double@x.com'];
  const loaded = await roundTrip({ ...base, MUTED_SENDERS: senders });
  assert.deepEqual(loaded.MUTED_SENDERS, senders);
});

test('an empty mute list renders as an empty array', async () => {
  const loaded = await roundTrip({ ...base, MUTED_SENDERS: [] });
  assert.deepEqual(loaded.MUTED_SENDERS, []);
});
