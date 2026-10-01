// Validates a profile object. Deliberately separate from profile.mjs, which
// imports the real profile at load time: the scripts that create or repair a
// profile (setup:profile, the prebuild check) must be able to validate one
// without first loading the one that may be missing or broken.

export const REQUIRED_TEXT = ['ABOUT_YOU', 'RUBRIC', 'VOICE', 'REPLY_STYLE'];
const TIERS = ['HIGH', 'MEDIUM', 'LOW'];

// One full address, and nothing Gmail's query syntax would read as grouping or
// quoting. Anything looser is interpolated into the `-from:` term and can
// silently widen or break the search.
const ADDRESS = /^[^\s@"'(){}<>]+@[^\s@"'(){}<>]+\.[^\s@"'(){}<>]+$/;

/** Returns the validated profile, or throws one error naming everything wrong. */
export function validateProfile(profile) {
  const problems = [];

  for (const key of REQUIRED_TEXT) {
    const value = profile[key];
    if (typeof value !== 'string') problems.push(`${key} is missing (must export a string)`);
    else if (!value.trim()) problems.push(`${key} is empty`);
  }

  if (typeof profile.RUBRIC === 'string') {
    // Whole words only: "follow" does not mention LOW, "highlights" not HIGH.
    const missing = TIERS.filter((tier) => !new RegExp(`\\b${tier}\\b`, 'i').test(profile.RUBRIC));
    if (missing.length > 0) {
      problems.push(`RUBRIC never mentions ${missing.join(', ')} — the classifier needs all three tiers`);
    }
  }

  const muted = profile.MUTED_SENDERS;
  if (!Array.isArray(muted)) {
    problems.push('MUTED_SENDERS is missing (must export an array, [] if you mute nobody)');
  } else {
    for (const entry of muted) {
      if (typeof entry !== 'string' || !entry.trim()) {
        problems.push(`MUTED_SENDERS contains a non-string entry: ${JSON.stringify(entry)}`);
      } else if (/\s/.test(entry)) {
        // Interpolated straight into the Gmail query, where a space would
        // silently become a second search term.
        problems.push(`MUTED_SENDERS entry "${entry}" contains a space`);
      } else if (!entry.includes('@') || entry.startsWith('@')) {
        // A bare domain mutes every sender there, including real people.
        problems.push(
          `MUTED_SENDERS entry "${entry}" is a bare domain — use a full address, or you will mute real people at that domain`
        );
      } else if (!ADDRESS.test(entry)) {
        problems.push(
          `MUTED_SENDERS entry ${JSON.stringify(entry)} is not a plain email address (like name@example.com)`
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid profile (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nSee config/profile.example.mjs, or run: npm run setup:profile'
    );
  }

  return {
    ABOUT_YOU: profile.ABOUT_YOU,
    RUBRIC: profile.RUBRIC,
    VOICE: profile.VOICE,
    REPLY_STYLE: profile.REPLY_STYLE,
    MUTED_SENDERS: [...muted],
  };
}
