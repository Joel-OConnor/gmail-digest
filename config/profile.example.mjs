// Your digest profile: what matters to you, in plain English.
//
// Copy to config/profile.mjs (gitignored) and edit, or let the guided setup
// write it for you:  npm run setup:profile
//
// Everything here is injected verbatim into the classifier's prompt, except
// MUTED_SENDERS which is applied earlier, at the Gmail query. Write it the way
// you would explain your inbox to a new assistant. After editing, redeploy:
//   npm run deploy

// ---------------------------------------------------------------------------
// ABOUT_YOU — context the classifier needs to judge what is relevant to you.
// Roles, projects, obligations, the things you are currently dealing with.
// The more concrete, the better the triage. The classifier gets this in its own
// section, so the rubric below does not need to repeat it.
// ---------------------------------------------------------------------------
export const ABOUT_YOU = `I work in software. I care about anything a real person sends me directly, anything with a deadline, and anything involving money or legal obligations. I do not want to see marketing, newsletters, or automated notifications.`;

// ---------------------------------------------------------------------------
// RUBRIC — the three tiers. Only mail at or above MIN_IMPORTANCE (.env) is
// shown, so be honest about what genuinely belongs in HIGH.
// ---------------------------------------------------------------------------
export const RUBRIC = `**HIGH — needs my attention today:**
- A real person writing to me directly, not an automated system
- Anything with a deadline, a bill, a payment, or a legal or tax obligation
- Fraud alerts or genuine suspicious-activity warnings
- Time-sensitive logistics: appointments, travel, something due today

**MEDIUM — worth knowing, no urgency:**
- Statements and receipts for my records
- Order and shipping confirmations
- Replies in threads that can wait a day or two
- Event invitations and service notices with nothing to do yet

**LOW — noise:**
- Newsletters, marketing, promotions, social notifications
- Automated product digests and cold sales outreach
- Routine account housekeeping: password resets, verification codes, new
  sign-in notices, 2FA prompts (a real fraud warning is still HIGH)

Tie-breakers: an unknown human sender outranks anything automated; any email containing a direct question or request to me is at least MEDIUM.`;

// ---------------------------------------------------------------------------
// MUTED_SENDERS — never fetched, never classified, never shown. Cheaper and
// more certain than rating them low, since they never reach the model at all.
//
// Full addresses only. Entries are matched with Gmail's `-from:`, where a bare
// domain like "linkedin.com" would also mute real people who message you
// through LinkedIn, so the profile check rejects one.
// ---------------------------------------------------------------------------
export const MUTED_SENDERS = [
  // 'noreply@example.com',
];

// ---------------------------------------------------------------------------
// VOICE — how everything in the digest is written: summaries, bullet points,
// and drafted replies. The classifier treats every rule here as a hard
// constraint, so this is the place for any words or punctuation you never want
// to see. The default below is only a starting point: make it yours, or paste
// in a writing-style file if you already keep one.
// ---------------------------------------------------------------------------
export const VOICE = `Write plainly and directly, like a colleague talking, not a formal assistant. Conversational prose, short sentences. Lead with what happened, then what (if anything) I need to do. No corporate filler or pleasantries.`;

// ---------------------------------------------------------------------------
// REPLY_STYLE — rules for the drafted replies, on top of VOICE. Replies are
// only drafted for mail an actual person sent you; never for automated mail.
//
// The guards against inventing facts matter: a draft you have to fact-check
// before sending is worse than one that says less.
// ---------------------------------------------------------------------------
export const REPLY_STYLE = `Write in first person as me, matching the register of whoever wrote to me.

Rules:
- 40-90 words, and shorter when their message was short. Open with "Hi <first name>," and stop at the last sentence: no signature, I add that myself.
- Answer whatever they actually asked. If they proposed a call, agree and ask for times. If they asked a question, answer it.
- Never invent facts about my availability, commitments, prices, or plans. If a detail is needed and unknown, ask for it.
- Only claim experience that the "About the owner" section actually states. Do not assert familiarity with a specific product, tool, or domain it does not mention. If they lead with one, either leave it alone or say plainly that it is outside my day-to-day.
- Never use placeholders like [Your Name] or [date]. If a sentence cannot be written without inventing something, leave it out.
- If the email needs no reply, return an empty string instead.`;
