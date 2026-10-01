#!/usr/bin/env node
// Builds config/profile.mjs from a short interview, using your own Claude key.
//
//   npm run setup:profile
//
// You answer in plain English; Claude turns it into a rubric. Nothing is
// written until you have seen the result and said yes.
//
// Security note: the model's output is never executed. It comes back as
// structured JSON and this script generates the module itself, embedding every
// value with JSON.stringify. A model that returned code would produce a string
// containing code, not code.
import { createInterface } from 'node:readline/promises';
import { writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';

import { loadEnv, ssmPath, ROOT } from './lib/env.mjs';
import { renderProfile } from './lib/render-profile.mjs';
// Not src/profile.mjs: that loads config/profile.mjs at import time, and this
// script is exactly what you run when that file is missing or broken.
import { validateProfile } from '../src/validate-profile.mjs';

loadEnv();

const PROFILE_PATH = join(ROOT, 'config', 'profile.mjs');
const model = process.env.MODEL || 'claude-sonnet-4-6';

const QUESTIONS = [
  {
    key: 'work',
    q: 'What do you do, and what are you dealing with at the moment? (job, projects, obligations, anything ongoing)',
  },
  {
    key: 'urgent',
    q: 'What kind of email genuinely needs you the same day?',
  },
  {
    key: 'noise',
    q: 'What floods your inbox that you never want to see in a summary?',
  },
  {
    key: 'senders',
    q: 'Any specific senders to block outright? (full addresses, comma separated, or blank)',
  },
  {
    key: 'replies',
    q: 'When the digest drafts a reply for you, how should it sound? (blank for direct and casual)',
  },
];

// Claude fills this in. Every field lands in the generated module as a string
// literal, so the shape is the whole contract.
const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    ABOUT_YOU: {
      type: 'string',
      description:
        'One short paragraph, first person, describing the user and what matters to them. Written to be read by a classifier deciding what is relevant.',
    },
    RUBRIC: {
      type: 'string',
      description:
        'Markdown with exactly three sections headed **HIGH — …**, **MEDIUM — …** and **LOW — …**, each a bullet list drawn from the answers. End with a short tie-breaker sentence. Do not repeat ABOUT_YOU here; the classifier already receives it separately.',
    },
    MUTED_SENDERS: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Full email addresses only, never bare domains. Empty array if the user named none.',
    },
    VOICE: {
      type: 'string',
      description:
        'Rules for how the digest is written. Capture any writing preferences the user stated (tone, words or punctuation to avoid). If they gave none, default to plain, direct, conversational writing with no corporate filler.',
    },
    REPLY_STYLE: {
      type: 'string',
      description:
        'Rules for drafted replies: length, greeting, no signature, and the guards against inventing facts about the user.',
    },
  },
  required: ['ABOUT_YOU', 'RUBRIC', 'MUTED_SENDERS', 'VOICE', 'REPLY_STYLE'],
  additionalProperties: false,
};

async function anthropicKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const region = process.env.AWS_REGION;
  if (!region) return null;
  const res = await new SSMClient({ region }).send(
    new GetParametersCommand({ Names: [ssmPath('anthropic-api-key')], WithDecryption: true })
  );
  return res.Parameters?.[0]?.Value ?? null;
}

// --- interview ---------------------------------------------------------------

const key = await anthropicKey();
if (!key) {
  console.error('No Anthropic key found. Run `npm run setup` first, or set ANTHROPIC_API_KEY.');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`This builds your digest profile: what counts as important, what to ignore,
and how drafted replies should sound. Answer in plain English, as much or as
little as you like. Nothing is saved until you approve it.\n`);

const answers = {};
for (const { key: field, q } of QUESTIONS) {
  answers[field] = (await rl.question(`${q}\n> `)).trim();
  console.log('');
}

console.log(`Asking ${model} to turn that into a profile…\n`);

const client = new Anthropic({ apiKey: key });
const response = await client.messages.create({
  model,
  max_tokens: 4096,
  system: `You turn a person's plain-English answers into a configuration profile for an email triage tool.

The profile drives a classifier that reads their inbox twice a day and shows only what matters. Write in their voice, first person, concrete and specific. Prefer their own words over generic categories: "anything about the Henderson deal" beats "work correspondence".

Be decisive. If they were vague, make a sensible choice rather than hedging or leaving placeholders. Never invent facts about them that they did not state.`,
  tools: [
    {
      name: 'write_profile',
      description: 'Return the finished profile.',
      input_schema: PROFILE_SCHEMA,
    },
  ],
  tool_choice: { type: 'tool', name: 'write_profile' },
  messages: [
    {
      role: 'user',
      content: QUESTIONS.map(({ key: field, q }) => `${q}\n${answers[field] || '(no answer)'}`).join(
        '\n\n'
      ),
    },
  ],
});

const generated = response.content.find((block) => block.type === 'tool_use')?.input;
if (!generated) {
  console.error('The model did not return a profile. Try again, or edit config/profile.mjs by hand.');
  process.exit(1);
}

// Validate before showing it, so a bad generation fails here rather than at
// deploy time.
try {
  validateProfile(generated);
} catch (err) {
  console.error(`The generated profile is not valid:\n${err.message}`);
  process.exit(1);
}

console.log('─'.repeat(72));
console.log(`ABOUT YOU\n${generated.ABOUT_YOU}\n`);
console.log(`RUBRIC\n${generated.RUBRIC}\n`);
console.log(`MUTED SENDERS\n${generated.MUTED_SENDERS.join('\n') || '(none)'}\n`);
console.log(`VOICE\n${generated.VOICE}\n`);
console.log(`REPLY STYLE\n${generated.REPLY_STYLE}`);
console.log('─'.repeat(72));

const answer = (await rl.question('\nSave this to config/profile.mjs? [y/N] ')).trim().toLowerCase();
rl.close();

if (answer !== 'y' && answer !== 'yes') {
  console.log('Nothing written.');
  process.exit(0);
}

if (existsSync(PROFILE_PATH)) {
  const backup = `${PROFILE_PATH}.bak`;
  copyFileSync(PROFILE_PATH, backup);
  console.log(`Previous profile kept at ${backup}`);
}

writeFileSync(PROFILE_PATH, renderProfile(generated));

// Re-import in a fresh process would be needed to fully re-validate; the
// pre-write validation above already covers the content.
console.log(`
Written to config/profile.mjs.

  npm run doctor                  check it loads
  DRY_RUN=true npm run preview    see what a digest would look like
  npm run deploy                  push it to the Lambda
`);
