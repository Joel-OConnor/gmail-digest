import { gmail } from '@googleapis/gmail';
import { OAuth2Client } from 'google-auth-library';
import { PROFILE } from './profile.mjs';

const DIGEST_SUBJECT_PREFIX = '[Inbox Digest]';
// Digest-style mail (newsletters, alerts, listings) packs many items into one
// body, and 1,500 chars often cut off before the relevant one, so the classifier
// judged on a partial list. 4,000 keeps the cost trivial (~1k tokens/email).
const BODY_TRUNCATE_CHARS = 4000;
const LIST_HARD_CAP = 500; // upper bound on IDs we page through per run
const GET_CONCURRENCY = 8;

export function createGmailClient({ googleClientId, googleClientSecret, refreshToken }) {
  const auth = new OAuth2Client(googleClientId, googleClientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return gmail({ version: 'v1', auth });
}

/**
 * The address this token actually belongs to. Needed for the From header: a
 * message claiming to be from an address the account cannot send as fails
 * DMARC and lands in spam. Covered by gmail.readonly, already granted.
 */
export async function authenticatedAddress(client) {
  const res = await withRetry(() => client.users.getProfile({ userId: 'me' }));
  return res.data.emailAddress;
}

// Retry transient failures: 2 retries with backoff (1s, 2s + jitter).
export async function withRetry(fn, { retries = 2, baseDelayMs = 1000 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const delay = baseDelayMs * 2 ** attempt + Math.random() * 250;
      await new Promise((r) => {
        setTimeout(r, delay);
      });
    }
  }
  throw lastError;
}

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Build the Gmail search query for a run.
 *
 * scope 'inbox'   — only mail still sitting in the inbox at scan time. Mail you
 *                   archived before the run is invisible to the digest.
 * scope 'arrived' — everything that arrived in the window regardless of where it
 *                   is now (still excludes spam/trash, which Gmail omits by
 *                   default, plus chats). Survives triaging on your phone.
 *
 * `after:`/`before:` are second-granular, so the query includes the boundary
 * seconds (with slack) and the caller filters by exact internalDate — the
 * window boundary neither drops nor duplicates messages across runs.
 */
export function buildQuery({ sinceMs, untilMs, scope = 'inbox', muted = PROFILE.MUTED_SENDERS }) {
  const parts = [
    `after:${Math.floor(sinceMs / 1000)}`,
    `before:${Math.floor(untilMs / 1000) + 2}`,
    '-from:me',
    ...muted.map((sender) => `-from:${sender}`),
  ];
  if (scope === 'arrived') parts.push('-in:chats');
  else parts.unshift('in:inbox');
  return parts.join(' ');
}

/**
 * Map of threadId -> the time the owner last sent a message in that thread,
 * for threads touched since `sinceMs`. A reply to a message in this window is
 * necessarily newer than the message, so that window is enough.
 *
 * `format: 'minimal'` returns threadId, labelIds and internalDate without the
 * payload, which keeps this cheap: one list call plus a small get per sent message.
 *
 * `from:me` would also match drafts, which Gmail autosaves the moment you start
 * typing a reply, so an abandoned reply would hide the message. `in:sent` avoids
 * that, and the SENT label check is a second guard in case the search ever
 * returns something that was never actually sent.
 */
export async function fetchAnsweredThreads(client, sinceMs) {
  const ids = [];
  let pageToken;
  do {
    const res = await withRetry(() =>
      client.users.messages.list({
        userId: 'me',
        q: `in:sent after:${Math.floor(sinceMs / 1000)}`,
        maxResults: 100,
        pageToken,
      })
    );
    ids.push(...(res.data.messages ?? []).map((m) => m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < LIST_HARD_CAP);

  const sent = await mapPool(ids, GET_CONCURRENCY, (id) =>
    withRetry(() => client.users.messages.get({ userId: 'me', id, format: 'minimal' }))
  );

  const answeredAt = new Map();
  for (const { data } of sent) {
    if (!data.labelIds?.includes('SENT')) continue;
    const at = Number(data.internalDate ?? 0);
    if (at > (answeredAt.get(data.threadId) ?? 0)) answeredAt.set(data.threadId, at);
  }
  return answeredAt;
}

/**
 * Fetch messages with internalDate in (sinceMs, untilMs], excluding our own
 * digests and anything the owner has already replied to. Returns
 * { emails, overflowCount, overflowIsAtLeast, answeredCount } — capped at maxEmails.
 */
export async function fetchNewEmails(client, { sinceMs, untilMs, maxEmails, scope }) {
  const q = buildQuery({ sinceMs, untilMs, scope });

  const ids = [];
  let pageToken;
  do {
    const res = await withRetry(() =>
      client.users.messages.list({ userId: 'me', q, maxResults: 100, pageToken })
    );
    ids.push(...(res.data.messages ?? []).map((m) => m.id));
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken && ids.length < LIST_HARD_CAP);

  const capped = ids.slice(0, maxEmails);
  const messages = await mapPool(capped, GET_CONCURRENCY, (id) =>
    withRetry(() => client.users.messages.get({ userId: 'me', id, format: 'full' }))
  );

  const inWindow = messages
    .map((res) => parseMessage(res.data))
    .filter((e) => e.dateMs > sinceMs && e.dateMs <= untilMs)
    .filter((e) => !e.subject.startsWith(DIGEST_SUBJECT_PREFIX));

  // Already answered it? Then it needs neither a mention nor a drafted reply.
  // Dropped here rather than after classification, so it costs no Claude tokens.
  const answeredAt = await fetchAnsweredThreads(client, sinceMs);
  const emails = inWindow.filter((e) => !((answeredAt.get(e.threadId) ?? 0) > e.dateMs));
  const answeredCount = inWindow.length - emails.length;

  // When pagination stopped at LIST_HARD_CAP the true total is unknown, so the
  // overflow number is a floor, not an exact count. Floor it at 1 in that case:
  // with maxEmails >= LIST_HARD_CAP the subtraction is 0 or negative, which
  // previously reported "at least 0 additional emails" while dropping real mail.
  const overflowIsAtLeast = Boolean(pageToken);
  const overflowCount = Math.max(overflowIsAtLeast ? 1 : 0, ids.length - maxEmails);
  return { emails, overflowCount, overflowIsAtLeast, answeredCount };
}

const ENCODED_WORD = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;

/**
 * Decode RFC 2047 encoded-words ("=?UTF-8?B?...?=") that Gmail returns verbatim
 * in header values. Without this, any subject containing an emoji or accent
 * reaches the digest as raw "=?UTF-8?B?" gibberish — and our own digests (which
 * buildRawMessage always encodes) slip past the self-exclusion filter.
 * Unknown charsets are left untouched rather than mangled.
 */
export function decodeEncodedWords(value) {
  if (!value.includes('=?')) return value;
  // Whitespace separating two adjacent encoded-words is folding, not content.
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(ENCODED_WORD, (match, charset, encoding, text) => {
      try {
        const bytes =
          encoding.toUpperCase() === 'B'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text
                  .replace(/_/g, ' ')
                  .replace(/=([0-9A-Fa-f]{2})/g, (_m, hex) =>
                    String.fromCharCode(Number.parseInt(hex, 16))
                  ),
                'latin1'
              );
        // charset may carry an RFC 2231 language suffix (utf-8*en).
        return new TextDecoder(charset.split('*')[0]).decode(bytes);
      } catch {
        return match;
      }
    });
}

export function parseMessage(message) {
  const headers = Object.fromEntries(
    (message.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
  );
  const from = parseFrom(decodeEncodedWords(headers.from ?? ''));
  const subject = decodeEncodedWords(headers.subject ?? '');
  const body = extractBody(message.payload).slice(0, BODY_TRUNCATE_CHARS);
  return {
    id: message.id,
    threadId: message.threadId,
    from,
    // A blank subject would leave the digest item with no link text to click.
    subject: subject.trim() ? subject : '(no subject)',
    dateMs: Number(message.internalDate ?? 0),
    body,
  };
}

// "Jane Doe <jane@example.com>" -> { name: "Jane Doe", email: "jane@example.com" }
// Also handles quoted names with escapes and the legacy "addr (Name)" comment form.
export function parseFrom(raw) {
  const trimmed = raw.trim();
  const asResult = (name, email) => {
    const normalized = email.trim().toLowerCase();
    return {
      name: name.trim() || normalized || '(unknown sender)',
      email: normalized,
      domain: normalized.split('@')[1] ?? '',
    };
  };

  const angle = trimmed.match(/^(.*)<([^<>]+)>\s*$/s);
  if (angle) {
    const name = angle[1]
      .trim()
      .replace(/^"(.*)"$/s, '$1') // unquote display name
      .replace(/\\(["\\])/g, '$1'); // unescape \" and \\
    return asResult(name, angle[2]);
  }

  const comment = trimmed.match(/^([^\s()<>]+@[^\s()<>]+)\s*\(([^)]*)\)\s*$/);
  if (comment) return asResult(comment[2], comment[1]);

  return asResult('', trimmed);
}

export function extractBody(payload) {
  const plain = findPart(payload, 'text/plain');
  if (plain) return decodeBody(plain);
  const html = findPart(payload, 'text/html');
  if (html) return stripHtml(decodeBody(html));
  return '';
}

function findPart(part, mimeType, isRoot = true) {
  if (!part) return null;
  // Skip attachments (filename-bearing parts) and attached/forwarded messages
  // so a forwarded email's text is never mistaken for the message body.
  if (!isRoot && (part.filename || part.mimeType?.startsWith('message/'))) return null;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType, false);
    if (found) return found;
  }
  return null;
}

// Plenty of mail still goes out as iso-8859-1, windows-1252 or Shift_JIS, and
// reading those bytes as UTF-8 turns every accent into mojibake. An unknown
// charset makes TextDecoder throw, so fall back to UTF-8 rather than lose the body.
function decodeBody(part) {
  const bytes = Buffer.from(part.body.data, 'base64url');
  const contentType =
    part.headers?.find((h) => h.name.toLowerCase() === 'content-type')?.value ?? '';
  const charset = contentType.match(/charset\s*=\s*"?([^";\s]+)/i)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const decodeCharRef = (match, num) => {
  const n = num[0].toLowerCase() === 'x' ? Number.parseInt(num.slice(1), 16) : Number(num);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
};

export function stripHtml(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Marketing mail pads its preheader with invisible characters; left in,
    // they survive whitespace collapse and waste the truncated body.
    .replace(/&(?:zwnj|zwj|shy);/gi, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, decodeCharRef)
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]|\u034F/g, '')
    // Last, so "&amp;lt;" becomes the literal text "&lt;" rather than "<".
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build an RFC 2822 message, base64url-encoded for users.messages.send.
 * Subject uses MIME encoded-word (the em dash is non-ASCII); the HTML body
 * is base64 content-transfer-encoded and wrapped at 76 chars with CRLF, the
 * line limit RFC 2045 sets for base64 (well inside RFC 5322's 998).
 */
export function buildRawMessage({ from, to, subject, html }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const message = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})(?=.)/g, '$1\r\n'),
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

export async function sendDigest(client, { from, to, subject, html }) {
  const raw = buildRawMessage({ from, to, subject, html });
  await withRetry(() => client.users.messages.send({ userId: 'me', requestBody: { raw } }));
}
