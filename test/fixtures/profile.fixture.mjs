// Deterministic profile for the test suite. Resolved via the "#profile" import
// alias under `node --conditions=test`, so tests never read anyone's real
// preferences and a fresh clone can run them with no config at all.
//
// The sentinels are asserted verbatim: if a profile field ever stops reaching
// the classifier's prompt, a test fails instead of the digest quietly degrading.
export const ABOUT_YOU = 'FIXTURE-ABOUT-YOU: I test software for a living.';

export const RUBRIC = `**HIGH — FIXTURE-RUBRIC-HIGH:** anything urgent.
**MEDIUM — FIXTURE-RUBRIC-MEDIUM:** anything else worth reading.
**LOW — FIXTURE-RUBRIC-LOW:** noise.`;

export const MUTED_SENDERS = ['fixture-noise@example.com'];

export const VOICE = 'FIXTURE-VOICE: write plainly.';

export const REPLY_STYLE = 'FIXTURE-REPLY-STYLE: keep it under 90 words.';
