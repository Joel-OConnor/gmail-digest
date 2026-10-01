import test from 'node:test';
import assert from 'node:assert/strict';

import { validateProfile, REQUIRED_TEXT, PROFILE } from '../src/profile.mjs';

const valid = () => ({
  ABOUT_YOU: 'I work in software.',
  RUBRIC: 'HIGH: urgent. MEDIUM: later. LOW: noise.',
  VOICE: 'Write plainly.',
  REPLY_STYLE: 'Keep it short.',
  MUTED_SENDERS: ['noise@example.com'],
});

test('a complete profile validates and is returned normalised', () => {
  const out = validateProfile(valid());
  assert.deepEqual(Object.keys(out).sort(), [...REQUIRED_TEXT, 'MUTED_SENDERS'].sort());
  assert.deepEqual(out.MUTED_SENDERS, ['noise@example.com']);
});

test('MUTED_SENDERS is copied, so editing the result cannot mutate the profile', () => {
  const profile = valid();
  validateProfile(profile).MUTED_SENDERS.push('extra@example.com');
  assert.deepEqual(profile.MUTED_SENDERS, ['noise@example.com']);
});

test('every missing field is reported at once, not one per run', () => {
  // The whole point of the namespace import: a stranger fixes their profile in
  // one pass instead of rediscovering the next missing field each time.
  let message = '';
  try {
    validateProfile({});
  } catch (err) {
    message = err.message;
  }
  assert.ok(message, 'an empty profile must not validate');
  for (const key of REQUIRED_TEXT) assert.match(message, new RegExp(key));
  assert.match(message, /MUTED_SENDERS is missing/);
  assert.match(message, /5 problems/);
});

test('empty and non-string text fields are rejected', () => {
  assert.throws(() => validateProfile({ ...valid(), VOICE: '   ' }), /VOICE is empty/);
  assert.throws(() => validateProfile({ ...valid(), VOICE: 42 }), /VOICE is missing/);
});

test('a rubric missing a tier is rejected', () => {
  assert.throws(
    () => validateProfile({ ...valid(), RUBRIC: 'HIGH: urgent. LOW: noise.' }),
    /RUBRIC never mentions MEDIUM/
  );
  // Case-insensitive: people write "High" as often as "HIGH".
  assert.doesNotThrow(() =>
    validateProfile({ ...valid(), RUBRIC: 'High: urgent. Medium: later. Low: noise.' })
  );
});

test('a tier only counts as a whole word, not inside another word', () => {
  // "follow" is not a LOW tier and "highlights" is not a HIGH one.
  assert.throws(
    () => validateProfile({ ...valid(), RUBRIC: 'Highlights: urgent. MEDIUM: later. Things to follow: noise.' }),
    /RUBRIC never mentions HIGH, LOW/
  );
  assert.doesNotThrow(() =>
    validateProfile({ ...valid(), RUBRIC: '**HIGH**: urgent.\n**MEDIUM**: later.\n(low) noise.' })
  );
});

test('MUTED_SENDERS must be an array of usable addresses', () => {
  assert.throws(() => validateProfile({ ...valid(), MUTED_SENDERS: 'a@b.com' }), /must export an array/);
  assert.throws(() => validateProfile({ ...valid(), MUTED_SENDERS: [42] }), /non-string entry/);
  assert.throws(() => validateProfile({ ...valid(), MUTED_SENDERS: ['  '] }), /non-string entry/);
});

test('a space in a mute entry is rejected — it would become a second search term', () => {
  assert.throws(
    () => validateProfile({ ...valid(), MUTED_SENDERS: ['from me@x.com'] }),
    /contains a space/
  );
});

test('a bare domain is rejected — it would mute real people at that domain', () => {
  // The mistake that would silently delete the most valuable mail in the digest.
  assert.throws(
    () => validateProfile({ ...valid(), MUTED_SENDERS: ['linkedin.com'] }),
    /bare domain/
  );
  // Gmail reads "@linkedin.com" as the whole domain too.
  assert.throws(
    () => validateProfile({ ...valid(), MUTED_SENDERS: ['@linkedin.com'] }),
    /bare domain/
  );
});

test('a mute entry must be a plain full address', () => {
  // Quotes and brackets would change how the Gmail query parses.
  for (const bad of ['"a@b.com', 'a@b', 'a@b@c.com', '(a@b.com)', 'a@b.com>']) {
    assert.throws(
      () => validateProfile({ ...valid(), MUTED_SENDERS: [bad] }),
      /is not a plain email address/,
      `expected ${bad} to be rejected`
    );
  }
  assert.doesNotThrow(() =>
    validateProfile({ ...valid(), MUTED_SENDERS: ['no-reply+digest@mail.example.co.uk'] })
  );
});

test('an empty mute list is fine', () => {
  assert.doesNotThrow(() => validateProfile({ ...valid(), MUTED_SENDERS: [] }));
});

test('the loaded PROFILE is the validated fixture under test conditions', () => {
  assert.match(PROFILE.ABOUT_YOU, /^FIXTURE-ABOUT-YOU/);
  assert.deepEqual(PROFILE.MUTED_SENDERS, ['fixture-noise@example.com']);
});
