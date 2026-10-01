// Loads and validates the user's profile.
//
// `#profile` is an import alias declared in package.json: it resolves to
// config/profile.mjs normally, and to a fixed test fixture under
// `node --conditions=test`, so the suite never depends on anyone's real
// preferences. A namespace import is deliberate — it does not throw on a
// missing export, which lets validateProfile report every problem at once
// instead of dying on the first one.
import * as raw from '#profile';
import { validateProfile } from './validate-profile.mjs';

export { validateProfile, REQUIRED_TEXT } from './validate-profile.mjs';

// Validated at import time, so a broken profile fails the first local run,
// `npm run doctor`, and `npm run build` (whose prebuild step checks it) rather
// than producing a quietly wrong digest twice a day.
export const PROFILE = validateProfile(raw);
