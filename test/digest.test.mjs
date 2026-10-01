import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSubject,
  buildDigestHtml,
  formatWhen,
  escapeHtml,
  messageUrl,
} from '../src/digest.mjs';

const item = (over = {}) => ({
  id: 'm1',
  from: { name: 'Jane Doe', email: 'jane@example.com', domain: 'example.com' },
  subject: 'Hello',
  dateMs: 1_770_000_000_000,
  importance: 'high',
  summary: 'A short summary',
  details: [],
  from_person: false,
  suggested_reply: '',
  ...over,
});

test('escapeHtml escapes every HTML-significant character', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(escapeHtml(42), '42');
});

test('buildSubject: Morning before 13:00 local, Afternoon after', () => {
  const args = { timezone: 'UTC', total: 5, high: 2 };
  assert.match(
    buildSubject({ now: new Date('2026-07-15T09:00:00Z'), ...args }),
    /^\[Inbox Digest\] Wed Jul 15 — Morning \(5 emails, 2 high\)$/
  );
  assert.match(
    buildSubject({ now: new Date('2026-07-15T15:00:00Z'), ...args }),
    /Afternoon \(5 emails, 2 high\)$/
  );
});

test('buildSubject respects the configured timezone', () => {
  const now = new Date('2026-07-15T02:00:00Z'); // 21:00 Jul 14 in Chicago, 11:00 Jul 15 in Tokyo
  assert.match(buildSubject({ now, timezone: 'America/Chicago', total: 1, high: 0 }), /Tue Jul 14 — Afternoon/);
  assert.match(buildSubject({ now, timezone: 'Asia/Tokyo', total: 1, high: 0 }), /Wed Jul 15 — Morning/);
});

test('buildSubject throws on an invalid timezone (pins what a typo in TIMEZONE does)', () => {
  assert.throws(
    () => buildSubject({ now: new Date(), timezone: 'Not/AZone', total: 1, high: 0 }),
    RangeError
  );
});

test('formatWhen renders a readable local timestamp', () => {
  const when = formatWhen(Date.parse('2026-07-26T15:14:00Z'), 'America/New_York');
  assert.match(when, /Sun, Jul 26/);
  assert.match(when, /11:14/, 'rendered in the requested zone, not the host zone');
});

// --- structure ---------------------------------------------------------------

test('digest: one sender-grouped section, no separate Ranked list', () => {
  const html = buildDigestHtml({ items: [item()] });
  assert.ok(!html.includes('Ranked'), 'the Ranked section was removed');
  assert.ok(!html.includes('By sender'), 'no heading needed when there is only one grouping');
  assert.match(html, /Jane Doe/);
  // The subject appears once now, not once per section.
  assert.equal(html.split('Hello').length - 1, 1, 'subject should not be duplicated');
});

test('digest: senders ordered by volume, then alphabetically', () => {
  const mk = (name, email) => ({ name, email, domain: 'x.com' });
  const html = buildDigestHtml({
    items: [
      item({ id: 'a', from: mk('Zoe', 'z@x.com') }),
      item({ id: 'b', from: mk('Adam', 'a@x.com') }),
      item({ id: 'c', from: mk('Busy', 'busy@x.com') }),
      item({ id: 'd', from: mk('Busy', 'busy@x.com') }),
    ],
  });
  assert.ok(html.indexOf('Busy') < html.indexOf('Adam'), 'busiest sender first');
  assert.ok(html.indexOf('Adam') < html.indexOf('Zoe'), 'then alphabetical');
});

test('digest: within a sender, higher tiers first then newest', () => {
  const from = { name: 'Jane', email: 'jane@x.com', domain: 'x.com' };
  const html = buildDigestHtml({
    items: [
      item({ id: '1', from, importance: 'medium', subject: 'MedOld', dateMs: 1 }),
      item({ id: '2', from, importance: 'medium', subject: 'MedNew', dateMs: 2 }),
      item({ id: '3', from, importance: 'high', subject: 'HighOne', dateMs: 0 }),
    ],
  });
  const order = ['HighOne', 'MedNew', 'MedOld'].map((s) => html.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('digest: sender header shows domain and count, omitting an empty domain', () => {
  const withDomain = buildDigestHtml({ items: [item(), item({ id: 'b' })] });
  assert.match(withDomain, /@example\.com/);
  assert.match(withDomain, /2 emails/);

  const noDomain = buildDigestHtml({
    items: [item({ from: { name: 'NoDomain', email: '', domain: '' } })],
  });
  assert.ok(!noDomain.includes('@</span>'));
  assert.match(noDomain, /1 email</);
});

// --- per-email content -------------------------------------------------------

test('digest: each email shows tier, timestamp, summary, and a link', () => {
  const html = buildDigestHtml({ items: [item()], timezone: 'America/New_York' });
  assert.match(html, /High/);
  assert.match(html, /href="https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/m1"/);
  assert.match(html, /A short summary/);
  assert.match(html, /Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/, 'timestamp rendered');
});

test('digest: details render as bullets, and are omitted when empty', () => {
  const html = buildDigestHtml({
    items: [item({ details: ['Invoice #1042, $1,250', 'Due Friday (net 30)'] })],
  });
  assert.match(html, /<li[^>]*>Invoice #1042, \$1,250<\/li>/);
  assert.match(html, /Due Friday \(net 30\)/);
  assert.ok(!buildDigestHtml({ items: [item()] }).includes('<ul'), 'no empty bullet list');
  assert.ok(!buildDigestHtml({ items: [item({ details: undefined })] }).includes('<ul'));
});

test('digest: no needs-a-reply marker — everything shown already needs attention', () => {
  const html = buildDigestHtml({ items: [item()] });
  assert.ok(!html.includes('needs a reply'));
  assert.ok(!html.includes('&#9888;'));
});

// --- suggested replies -------------------------------------------------------

test('digest: a suggested reply renders in its own block, preserving line breaks', () => {
  const draft = 'Hi Sam,\n\nThanks for the quote. March works for us.';
  const html = buildDigestHtml({ items: [item({ from_person: true, suggested_reply: draft })] });

  assert.match(html, /Suggested reply/);
  assert.match(html, /Thanks for the quote/);
  assert.match(html, /white-space:pre-wrap/, 'line breaks must survive');
});

test('digest: no reply block when there is no draft', () => {
  assert.ok(!buildDigestHtml({ items: [item()] }).includes('Suggested reply'));
  assert.ok(!buildDigestHtml({ items: [item({ suggested_reply: '' })] }).includes('Suggested reply'));
});

test('digest: a reply draft is HTML-escaped like everything else', () => {
  const html = buildDigestHtml({
    items: [item({ from_person: true, suggested_reply: '<script>alert(1)</script>' })],
  });
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('digest: subjects, sender names, and details are HTML-escaped', () => {
  const html = buildDigestHtml({
    items: [
      item({
        subject: '<script>x</script>',
        from: { name: 'A&B', email: 'a@b.com', domain: 'b.com' },
        details: ['<img src=x onerror=1>'],
      }),
    ],
  });
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.match(html, /A&amp;B/);
});

// --- footers -----------------------------------------------------------------

test('digest: overflow note — exact count, plural', () => {
  const html = buildDigestHtml({ items: [item()], overflowCount: 7 });
  assert.match(html, /7 additional emails arrived .* and are not shown\. They will not reappear/s);
  assert.ok(!html.includes('at least'));
});

test('digest: overflow note — singular grammar', () => {
  const html = buildDigestHtml({ items: [item()], overflowCount: 1 });
  assert.match(html, /1 additional email arrived .* and is not shown\. It will not reappear/s);
});

test('digest: overflow note — truncated page reports a floor', () => {
  const html = buildDigestHtml({ items: [item()], overflowCount: 400, overflowIsAtLeast: true });
  assert.match(html, /at least 400 additional emails/);
  assert.ok(!html.includes('at least 0'), 'never claim "at least 0"');
});

test('digest: the cap it names is per mailbox, which is how MAX_EMAILS applies', () => {
  const html = buildDigestHtml({ items: [item()], overflowCount: 2 });
  assert.match(html, /beyond the per-mailbox cap/);
});

test('digest: overflow alone still renders a readable digest', () => {
  // A run where every fetched email was filtered out, but more arrived than
  // the cap allowed, sends only this note.
  const html = buildDigestHtml({ items: [], overflowCount: 3, filteredCount: 2 });
  assert.match(html, /3 additional emails arrived/);
  assert.match(html, /2 low-priority emails left out/);
  assert.ok(!html.includes('undefined'));
  assert.ok(!html.includes('mail.google.com'), 'no email sections without emails');
});

test('buildSubject with nothing shown still reads correctly', () => {
  const now = new Date('2026-07-15T09:00:00Z');
  const subject = buildSubject({ now, timezone: 'UTC', total: 0, high: 0 });
  assert.match(subject, /\(0 emails, 0 high\)$/);
});

test('digest: no overflow note when nothing overflowed', () => {
  assert.ok(!buildDigestHtml({ items: [item()], overflowCount: 0 }).includes('additional email'));
});

test('digest: footer accounts for what was left out, and vanishes at zero', () => {
  const one = (args) => buildDigestHtml({ items: [item()], ...args });
  assert.match(one({ filteredCount: 7 }), /7 low-priority emails left out/);
  assert.match(one({ answeredCount: 2 }), /2 already answered emails left out/);
  assert.match(one({ filteredCount: 14, answeredCount: 2 }), /14 low-priority, 2 already answered emails left out/);
  assert.match(one({ answeredCount: 1 }), /1 already answered email left out/, 'singular');
  assert.ok(!one({}).includes('left out'));
});

// --- multi-account ------------------------------------------------------------

test('messageUrl addresses the mailbox by email, falling back to /u/0', () => {
  // /u/0 is whichever account was signed into first, so with two mailboxes half
  // the links would open "message not found".
  assert.equal(
    messageUrl('m1', 'work@example.com'),
    'https://mail.google.com/mail/u/work%40example.com/#all/m1'
  );
  assert.equal(messageUrl('m1'), 'https://mail.google.com/mail/u/0/#all/m1');
  assert.equal(messageUrl('m1', ''), 'https://mail.google.com/mail/u/0/#all/m1');
});

test('digest: links point at the mailbox each email landed in', () => {
  const html = buildDigestHtml({
    items: [item({ id: 'm1', accountAddress: 'work@example.com' })],
  });
  assert.ok(html.includes('mail/u/work%40example.com/#all/m1'));
});

test('digest: the account tag appears only when more than one is scanned', () => {
  const items = [item({ account: 'work' })];
  assert.ok(buildDigestHtml({ items, showAccounts: true }).includes('work'));
  assert.ok(!buildDigestHtml({ items }).includes('work'), 'one mailbox needs no label');
  assert.ok(
    !buildDigestHtml({ items: [item()], showAccounts: true }).includes('&middot; <span'),
    'an untagged email renders no empty label'
  );
});
