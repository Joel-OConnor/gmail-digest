import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGmailClient,
  authenticatedAddress,
  withRetry,
  buildQuery,
  fetchNewEmails,
  fetchAnsweredThreads,
  parseMessage,
  parseFrom,
  extractBody,
  stripHtml,
  decodeEncodedWords,
  buildRawMessage,
  sendDigest,
} from '../src/gmail.mjs';

const b64url = (s) => Buffer.from(s, 'utf8').toString('base64url');

const message = (over = {}) => ({
  id: 'm1',
  internalDate: String(1_770_000_000_000),
  payload: {
    mimeType: 'text/plain',
    headers: [
      { name: 'From', value: 'Jane Doe <jane@example.com>' },
      { name: 'Subject', value: 'Hello there' },
    ],
    body: { data: b64url('plain body') },
  },
  ...over,
});

// --- client construction -----------------------------------------------------

test('createGmailClient wires the refresh token into an OAuth2 client', () => {
  const client = createGmailClient({
    googleClientId: 'id.apps.googleusercontent.com',
    googleClientSecret: 'secret',
    refreshToken: 'refresh-abc',
  });
  assert.equal(typeof client.users.messages.list, 'function');
  assert.equal(typeof client.users.messages.send, 'function');
  assert.equal(client.context._options.auth.credentials.refresh_token, 'refresh-abc');
});

test('authenticatedAddress reports which mailbox the token actually opens', async () => {
  const client = {
    users: { getProfile: (args) => Promise.resolve({ data: { emailAddress: `${args.userId}@x.com` } }) },
  };
  assert.equal(await authenticatedAddress(client), 'me@x.com');
});

// --- retry -------------------------------------------------------------------

test('withRetry succeeds after a transient failure', async () => {
  let calls = 0;
  const result = await withRetry(
    () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('flaky')) : Promise.resolve('ok');
    },
    { baseDelayMs: 0 }
  );
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('withRetry gives up after the retry budget and rethrows the LAST error', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        () => {
          calls++;
          return Promise.reject(new Error(`attempt-${calls}`));
        },
        { baseDelayMs: 0 }
      ),
    /attempt-3/
  );
  assert.equal(calls, 3, 'initial attempt + 2 retries');
});

test('withRetry uses its documented defaults when called without options', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (fn) => fn()); // collapse the backoff
  let calls = 0;
  await withRetry(() => {
    calls++;
    return calls === 1 ? Promise.reject(new Error('once')) : Promise.resolve('done');
  });
  assert.equal(calls, 2);
});

// --- query building ----------------------------------------------------------

test('buildQuery: inbox scope vs arrived scope', () => {
  const args = { sinceMs: 1_000_000_000_000, untilMs: 1_000_003_600_000 };
  const inbox = buildQuery({ ...args, scope: 'inbox' });
  const arrived = buildQuery({ ...args, scope: 'arrived' });

  assert.ok(inbox.startsWith('in:inbox '));
  assert.ok(!arrived.includes('in:inbox'));
  assert.ok(arrived.includes('-in:chats'));
  for (const q of [inbox, arrived]) {
    assert.ok(q.includes('after:1000000000'));
    assert.ok(q.includes('before:1000003602'), 'boundary slack of +2s');
    assert.ok(q.includes('-from:me'));
  }
  assert.equal(buildQuery(args), inbox, 'defaults to the conservative inbox scope');
});

test('buildQuery mutes the configured senders', () => {
  const q = buildQuery({ sinceMs: 1e12, untilMs: 1e12 + 1000, muted: ['noisy@example.com'] });
  assert.ok(q.includes('-from:noisy@example.com'));
  assert.ok(!buildQuery({ sinceMs: 1e12, untilMs: 1e12 + 1000, muted: [] }).includes('-from:noisy'));
  // No stray whitespace when the list is empty.
  assert.ok(!buildQuery({ sinceMs: 1e12, untilMs: 1e12 + 1000, muted: [] }).includes('  '));
});

// --- header / body parsing ---------------------------------------------------

test('parseFrom handles angle-addr, quoting, escapes, and the comment form', () => {
  assert.deepEqual(parseFrom('Jane Doe <jane@example.com>'), {
    name: 'Jane Doe',
    email: 'jane@example.com',
    domain: 'example.com',
  });
  assert.deepEqual(parseFrom('"John \\"JJ\\" Smith" <jj@example.com>'), {
    name: 'John "JJ" Smith',
    email: 'jj@example.com',
    domain: 'example.com',
  });
  assert.deepEqual(parseFrom('jj@example.com (John Smith)'), {
    name: 'John Smith',
    email: 'jj@example.com',
    domain: 'example.com',
  });
});

test('parseFrom degrades gracefully on garbage', () => {
  assert.deepEqual(parseFrom('weird-no-at-sign'), {
    name: 'weird-no-at-sign',
    email: 'weird-no-at-sign',
    domain: '',
  });
  assert.equal(parseFrom('').name, '(unknown sender)');
});

test('decodeEncodedWords decodes B and Q words, joins adjacent ones, ignores plain text', () => {
  assert.equal(decodeEncodedWords('plain subject'), 'plain subject');
  assert.equal(decodeEncodedWords('=?UTF-8?B?W0luYm94IERpZ2VzdF0=?='), '[Inbox Digest]');
  assert.equal(decodeEncodedWords('=?UTF-8?Q?Caf=C3=A9_meeting?='), 'Café meeting');
  assert.equal(decodeEncodedWords('=?UTF-8?B?8J+agCA=?= =?UTF-8?B?bGF1bmNo?='), '🚀 launch');
});

test('decodeEncodedWords leaves an unknown charset untouched rather than mangling it', () => {
  const raw = '=?definitely-not-a-charset?B?aGk=?=';
  assert.equal(decodeEncodedWords(raw), raw);
});

test('extractBody prefers text/plain, falls back to stripped HTML, else empty', () => {
  assert.equal(extractBody({ mimeType: 'text/plain', body: { data: b64url('hi') } }), 'hi');
  assert.equal(
    extractBody({ mimeType: 'text/html', body: { data: b64url('<p>hi <b>there</b></p>') } }),
    'hi there'
  );
  assert.equal(extractBody({ mimeType: 'image/png', body: {} }), '');
  assert.equal(extractBody(undefined), '');
});

test('extractBody skips attachments and forwarded messages', () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      {
        mimeType: 'message/rfc822',
        filename: 'forwarded.eml',
        parts: [{ mimeType: 'text/plain', body: { data: b64url('forwarded body') } }],
      },
      { mimeType: 'text/plain', filename: 'notes.txt', body: { data: b64url('attachment text') } },
      { mimeType: 'text/html', body: { data: b64url('<p>real body</p>') } },
    ],
  };
  assert.equal(extractBody(payload), 'real body');
});

const partIn = (mimeType, contentType, bytes) => ({
  mimeType,
  headers: [{ name: 'Content-Type', value: contentType }],
  body: { data: Buffer.from(bytes).toString('base64url') },
});

test('extractBody decodes a text/plain part in its declared charset', () => {
  // "Café à 5€" in iso-8859-1: é=E9, à=E0. No euro in latin-1, so stop there.
  const latin1 = Buffer.from('Caf\xe9 \xe0 5', 'latin1');
  assert.equal(
    extractBody(partIn('text/plain', 'text/plain; charset="iso-8859-1"', latin1)),
    'Café à 5'
  );
});

test('extractBody decodes a text/html part in its declared charset', () => {
  // 0x92 and 0x80 are a curly apostrophe and the euro sign only in windows-1252.
  const cp1252 = Buffer.from('<p>It\x92s \x805</p>', 'latin1');
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [partIn('text/html', 'text/html; charset=windows-1252', cp1252)],
  };
  assert.equal(extractBody(payload), 'It\u2019s \u20ac5');
});

test('extractBody falls back to UTF-8 for an unknown or missing charset', () => {
  const utf8 = Buffer.from('Café', 'utf8');
  assert.equal(extractBody(partIn('text/plain', 'text/plain; charset=x-made-up', utf8)), 'Café');
  assert.equal(extractBody(partIn('text/plain', 'text/plain', utf8)), 'Café');
});

test('stripHtml drops scripts, styles, and tags, and decodes entities', () => {
  const html = '<style>p{color:red}</style><script>evil()</script><p>Hello&nbsp;&amp; welcome</p>';
  const text = stripHtml(html);
  assert.ok(!text.includes('evil()'));
  assert.ok(!text.includes('color:red'));
  assert.match(text, /Hello & welcome/);
});

test('stripHtml decodes numeric character references, rejecting out-of-range ones', () => {
  assert.equal(stripHtml('It&#8217;s &#x2019;ok&#X2019;'), 'It\u2019s \u2019ok\u2019');
  assert.equal(stripHtml('a &#0; b &#x110000; c'), 'a &#0; b &#x110000; c');
});

test('stripHtml removes zero-width and padding characters before collapsing space', () => {
  const padded = 'Preview&zwnj;&zwj;&shy; \u00ad\u034f\u200b\u200c\u200d\u2060\ufeff&#8203; text';
  assert.equal(stripHtml(padded), 'Preview text');
});

test('stripHtml decodes &amp; last, so an escaped entity stays literal', () => {
  assert.equal(stripHtml('&amp;lt;b&amp;gt; &amp;#8217;'), '&lt;b&gt; &#8217;');
});

test('parseMessage extracts headers, decodes the subject, and truncates the body', () => {
  const parsed = parseMessage(
    message({
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: '=?UTF-8?Q?Jos=C3=A9?= <jose@x.com>' },
          { name: 'Subject', value: '=?UTF-8?B?SGVsbG8g8J+Riw==?=' },
        ],
        body: { data: b64url('x'.repeat(9000)) },
      },
    })
  );
  assert.equal(parsed.subject, 'Hello 👋');
  assert.equal(parsed.from.name, 'José');
  assert.equal(parsed.dateMs, 1_770_000_000_000);
  assert.equal(parsed.body.length, 4000, 'body truncated to 4000 chars');
  assert.equal(parseMessage(message()).body, 'plain body', 'short bodies pass through');
});

test('parseMessage supplies defaults for a message with nothing in it', () => {
  const parsed = parseMessage({});
  assert.equal(parsed.subject, '(no subject)');
  assert.equal(parsed.dateMs, 0);
  assert.equal(parsed.body, '');
  assert.equal(parsed.from.name, '(unknown sender)');
});

// --- fetching ----------------------------------------------------------------

// Fake Gmail client over a fixed store; `pages` controls pagination.
function fakeGmail(store, { pages = 1, sent = {} } = {}) {
  const all = { ...store, ...sent };
  return {
    listCalls: [],
    users: {
      messages: {
        list(req) {
          this.parent.listCalls.push(req);
          // The reply lookup asks for `in:sent`; everything else is the window.
          if (req.q.startsWith('in:sent')) {
            return Promise.resolve({ data: { messages: Object.keys(sent).map((id) => ({ id })) } });
          }
          const page = req.pageToken ? Number(req.pageToken.slice(1)) + 1 : 1;
          return Promise.resolve({
            data: {
              messages: Object.keys(store).map((id) => ({ id })),
              nextPageToken: page < pages ? `p${page}` : undefined,
            },
          });
        },
        get: ({ id }) => Promise.resolve({ data: all[id] }),
      },
    },
  };
}
// give the inner `list` access to the recorder
const withRecorder = (client) => {
  client.users.messages.parent = client;
  return client;
};

const msg = (id, dateMs, subject) =>
  message({
    id,
    internalDate: String(dateMs),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'S <s@x.com>' },
        { name: 'Subject', value: subject ?? `Subject ${id}` },
      ],
      body: { data: b64url('body') },
    },
  });

test('fetchNewEmails: window is exclusive at the start and inclusive at the end', async () => {
  const T = 1_770_000_000_000;
  const store = {
    atStart: msg('atStart', T),
    inside: msg('inside', T + 1000),
    atEnd: msg('atEnd', T + 3_600_000),
    afterEnd: msg('afterEnd', T + 3_600_001),
  };
  const { emails, overflowCount, overflowIsAtLeast } = await fetchNewEmails(
    withRecorder(fakeGmail(store)),
    { sinceMs: T, untilMs: T + 3_600_000, maxEmails: 100 }
  );
  assert.deepEqual(emails.map((e) => e.id).sort(), ['atEnd', 'inside']);
  assert.equal(overflowCount, 0);
  assert.equal(overflowIsAtLeast, false);
});

test('fetchNewEmails: excludes our own digests by subject prefix', async () => {
  const T = 1_770_000_000_000;
  const store = {
    keep: msg('keep', T + 10),
    ours: msg('ours', T + 20, '[Inbox Digest] Tue Jul 14 — Morning (1 emails, 0 high)'),
  };
  const { emails } = await fetchNewEmails(withRecorder(fakeGmail(store)), {
    sinceMs: T,
    untilMs: T + 1000,
    maxEmails: 100,
  });
  assert.deepEqual(emails.map((e) => e.id), ['keep']);
});

test('fetchNewEmails: MIME-encoded digest subjects are still excluded', async () => {
  const T = 1_770_000_000_000;
  const encoded = '=?UTF-8?B?' + Buffer.from('[Inbox Digest] Sat Jul 25', 'utf8').toString('base64') + '?=';
  const store = { keep: msg('keep', T + 10), ours: msg('ours', T + 20, encoded) };
  const { emails } = await fetchNewEmails(withRecorder(fakeGmail(store)), {
    sinceMs: T,
    untilMs: T + 1000,
    maxEmails: 100,
  });
  assert.deepEqual(emails.map((e) => e.id), ['keep'], 'encoded self-send leaked back in');
});

test('fetchNewEmails: caps at maxEmails and reports the overflow', async () => {
  const T = 1_770_000_000_000;
  const store = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`m${i}`, msg(`m${i}`, T + i + 1)])
  );
  const { emails, overflowCount, overflowIsAtLeast } = await fetchNewEmails(
    withRecorder(fakeGmail(store)),
    { sinceMs: T, untilMs: T + 10_000, maxEmails: 2 }
  );
  assert.equal(emails.length, 2);
  assert.equal(overflowCount, 3);
  assert.equal(overflowIsAtLeast, false);
});

test('fetchNewEmails: a truncated id list never reports "at least 0"', async () => {
  const T = 1_770_000_000_000;
  const store = { a: msg('a', T + 1) };
  // pages: 999 keeps handing back a nextPageToken until LIST_HARD_CAP stops it.
  const { overflowCount, overflowIsAtLeast } = await fetchNewEmails(
    withRecorder(fakeGmail(store, { pages: 999 })),
    { sinceMs: T, untilMs: T + 10_000, maxEmails: 600 }
  );
  assert.equal(overflowIsAtLeast, true);
  assert.ok(overflowCount >= 1, `overflowCount was ${overflowCount}`);
});

test('fetchNewEmails: pages until the token runs out; a page with no messages is fine', async () => {
  const T = 1_770_000_000_000;
  // One distinct message per page, so paging is observable in the result.
  const store = { a: msg('a', T + 1), b: msg('b', T + 2), c: msg('c', T + 3) };
  const ids = Object.keys(store);
  const client = {
    listCalls: [],
    users: {
      messages: {
        list(req) {
          if (req.q.startsWith('in:sent')) return Promise.resolve({ data: {} });
          client.listCalls.push(req);
          const page = req.pageToken ? Number(req.pageToken.slice(1)) + 1 : 0;
          const next = page + 1 < ids.length ? `p${page}` : undefined;
          return Promise.resolve({ data: { messages: [{ id: ids[page] }], nextPageToken: next } });
        },
        get: ({ id }) => Promise.resolve({ data: store[id] }),
      },
    },
  };
  const { emails } = await fetchNewEmails(client, { sinceMs: T, untilMs: T + 9999, maxEmails: 100 });
  assert.equal(client.listCalls.length, 3, 'followed both continuation tokens');
  assert.equal(client.listCalls[0].pageToken, undefined, 'first page asks for no token');
  assert.deepEqual(emails.map((e) => e.id).sort(), ['a', 'b', 'c']);

  const empty = {
    users: { messages: { list: () => Promise.resolve({ data: {} }), get: () => Promise.resolve({ data: {} }) } },
  };
  const out = await fetchNewEmails(empty, { sinceMs: T, untilMs: T + 1, maxEmails: 10 });
  assert.deepEqual(out.emails, []);
});

test('fetchNewEmails sends the query for the requested scope', async () => {
  const T = 1_770_000_000_000;
  const qFor = async (scope) => {
    const client = withRecorder(fakeGmail({}));
    await fetchNewEmails(client, { sinceMs: T, untilMs: T + 1000, maxEmails: 10, scope });
    return client.listCalls[0].q;
  };
  assert.ok((await qFor('inbox')).startsWith('in:inbox '));
  const arrived = await qFor('arrived');
  assert.ok(arrived.includes('-in:chats'));
  assert.ok(!arrived.includes('in:inbox'));
});

// --- sending -----------------------------------------------------------------

test('buildRawMessage produces decodable RFC822 with an encoded-word subject', () => {
  const raw = buildRawMessage({
    from: 'me@example.com',
    to: 'me@example.com',
    subject: 'Digest — 5 emails',
    html: '<p>hi</p>',
  });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(decoded, /^From: me@example\.com$/m);
  assert.match(decoded, /^To: me@example\.com$/m);
  assert.match(decoded, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(decoded, /Content-Type: text\/html/);

  const encodedSubject = decoded.match(/^Subject: =\?UTF-8\?B\?(.+)\?=$/m)[1];
  assert.equal(Buffer.from(encodedSubject, 'base64').toString('utf8'), 'Digest — 5 emails');
  const body = decoded.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), '<p>hi</p>');
});

test('buildRawMessage wraps the base64 body at 76 chars per line', () => {
  const html = `<p>${'Digest item é '.repeat(40)}</p>`;
  const raw = buildRawMessage({ from: 'a@b.com', to: 'a@b.com', subject: 's', html });
  const body = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[1];
  const lines = body.split('\r\n');
  assert.ok(lines.length > 1, 'long enough to need wrapping');
  for (const line of lines.slice(0, -1)) assert.equal(line.length, 76);
  assert.ok(lines.at(-1).length <= 76, `last line of ${lines.at(-1).length} chars`);
  assert.ok(!body.endsWith('\r\n'), 'no dangling empty line');
  assert.equal(Buffer.from(lines.join(''), 'base64').toString('utf8'), html);
});

test('buildRawMessage wraps a body on an exact 76-char boundary into full lines', () => {
  // 57 and 114 bytes encode to exactly 76 and 152 base64 chars, where a
  // backtracking wrap would split off a 1-char tail line.
  for (const bytes of [57, 114]) {
    const html = 'a'.repeat(bytes);
    const raw = buildRawMessage({ from: 'a@b.com', to: 'a@b.com', subject: 's', html });
    const body = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[1];
    assert.deepEqual(body.split('\r\n').map((l) => l.length), Array(bytes / 57).fill(76));
    assert.equal(Buffer.from(body, 'base64').toString('utf8'), html);
  }
});

test('sendDigest posts the encoded message as the authenticated user', async () => {
  const sent = [];
  const client = {
    users: {
      messages: {
        send: (req) => {
          sent.push(req);
          return Promise.resolve({ data: { id: 'sent-1' } });
        },
      },
    },
  };
  await sendDigest(client, {
    from: 'me@example.com',
    to: 'me@example.com',
    subject: 'Subj',
    html: '<p>x</p>',
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].userId, 'me');
  const decoded = Buffer.from(sent[0].requestBody.raw, 'base64url').toString('utf8');
  assert.match(decoded, /^From: me@example\.com$/m);
  assert.match(decoded, /^To: me@example\.com$/m);
});

test('sendDigest retries a transient failure', async (t) => {
  t.mock.method(globalThis, 'setTimeout', (fn) => fn()); // collapse the backoff
  let calls = 0;
  const client = {
    users: {
      messages: {
        send: () => {
          calls++;
          return calls === 1 ? Promise.reject(new Error('502')) : Promise.resolve({ data: {} });
        },
      },
    },
  };
  await sendDigest(client, { from: 'a@b.com', to: 'a@b.com', subject: 's', html: '<p>x</p>' });
  assert.equal(calls, 2);
});

// --- already-answered detection ----------------------------------------------

const sentMsg = (id, threadId, dateMs) => ({
  id,
  threadId,
  labelIds: ['SENT'],
  internalDate: String(dateMs),
});

test('fetchAnsweredThreads maps each thread to the latest time I sent in it', async () => {
  const sent = {
    s1: sentMsg('s1', 't1', 1000),
    s2: sentMsg('s2', 't1', 3000), // later reply in the same thread wins
    s3: sentMsg('s3', 't2', 2000),
  };
  const client = {
    calls: [],
    users: {
      messages: {
        list(req) {
          client.calls.push(req.q);
          return Promise.resolve({ data: { messages: Object.keys(sent).map((id) => ({ id })) } });
        },
        get: ({ id, format }) => {
          assert.equal(format, 'minimal', 'no need to download bodies of my own mail');
          return Promise.resolve({ data: sent[id] });
        },
      },
    },
  };

  const answered = await fetchAnsweredThreads(client, 1_770_000_000_000);
  assert.match(client.calls[0], /^in:sent after:\d+$/);
  assert.equal(answered.get('t1'), 3000);
  assert.equal(answered.get('t2'), 2000);
  assert.equal(answered.size, 2);
});

test('fetchAnsweredThreads ignores drafts, which never carry the SENT label', async () => {
  const found = {
    draft: { id: 'draft', threadId: 't1', labelIds: ['DRAFT'], internalDate: '9000' },
    bare: { id: 'bare', threadId: 't2', internalDate: '9000' }, // no labelIds at all
    real: sentMsg('real', 't3', 4000),
  };
  const client = {
    users: {
      messages: {
        list: () => Promise.resolve({ data: { messages: Object.keys(found).map((id) => ({ id })) } }),
        get: ({ id }) => Promise.resolve({ data: found[id] }),
      },
    },
  };
  const answered = await fetchAnsweredThreads(client, 0);
  assert.deepEqual([...answered], [['t3', 4000]], 'an unsent draft must not count as a reply');
});

test('fetchAnsweredThreads copes with no sent mail at all', async () => {
  const client = {
    users: {
      messages: {
        list: () => Promise.resolve({ data: {} }),
        get: () => Promise.reject(new Error('should not be called')),
      },
    },
  };
  assert.equal((await fetchAnsweredThreads(client, 0)).size, 0);
});

test('fetchNewEmails drops mail I have already replied to', async () => {
  const T = 1_770_000_000_000;
  const answered = msg('answered', T + 1000);
  answered.threadId = 'thread-answered';
  const unanswered = msg('unanswered', T + 1000);
  unanswered.threadId = 'thread-open';

  const client = withRecorder(
    fakeGmail(
      { answered, unanswered },
      // I replied in thread-answered a minute after it arrived.
      { sent: { s1: sentMsg('s1', 'thread-answered', T + 61_000) } }
    )
  );
  const { emails, answeredCount } = await fetchNewEmails(client, {
    sinceMs: T,
    untilMs: T + 3_600_000,
    maxEmails: 100,
  });

  assert.deepEqual(emails.map((e) => e.id), ['unanswered']);
  assert.equal(answeredCount, 1);
});

test('fetchNewEmails keeps a message that arrived after my last reply', async () => {
  const T = 1_770_000_000_000;
  const followUp = msg('followup', T + 120_000); // they wrote back after I replied
  followUp.threadId = 'thread-x';

  const client = withRecorder(
    fakeGmail({ followUp }, { sent: { s1: sentMsg('s1', 'thread-x', T + 60_000) } })
  );
  const { emails, answeredCount } = await fetchNewEmails(client, {
    sinceMs: T,
    untilMs: T + 3_600_000,
    maxEmails: 100,
  });

  assert.deepEqual(emails.map((e) => e.id), ['followup'], 'the ball is back in my court');
  assert.equal(answeredCount, 0);
});

test('parseMessage treats an empty or blank Subject like a missing one', () => {
  const withSubject = (value) =>
    parseMessage(
      message({
        payload: { mimeType: 'text/plain', headers: [{ name: 'Subject', value }], body: {} },
      })
    ).subject;
  assert.equal(withSubject(''), '(no subject)');
  assert.equal(withSubject('   '), '(no subject)');
  assert.equal(withSubject(' Hi '), ' Hi ', 'a real subject is left alone');
});

test('parseMessage carries threadId, which the reply check depends on', () => {
  const parsed = parseMessage({ id: 'm1', threadId: 't9', internalDate: '5' });
  assert.equal(parsed.threadId, 't9');
});

test('fetchAnsweredThreads pages through sent mail and tolerates a missing date', async () => {
  const sent = {
    s1: sentMsg('s1', 't1', 5000),
    s2: { id: 's2', threadId: 't2', labelIds: ['SENT'] }, // no internalDate at all
  };
  const ids = Object.keys(sent);
  const tokens = [];
  const client = {
    users: {
      messages: {
        list: (req) => {
          tokens.push(req.pageToken);
          const page = req.pageToken ? Number(req.pageToken.slice(1)) + 1 : 0;
          const next = page + 1 < ids.length ? `p${page}` : undefined;
          return Promise.resolve({ data: { messages: [{ id: ids[page] }], nextPageToken: next } });
        },
        get: ({ id }) => Promise.resolve({ data: sent[id] }),
      },
    },
  };

  const answered = await fetchAnsweredThreads(client, 0);
  assert.deepEqual(tokens, [undefined, 'p0'], 'first page asks for no token');
  assert.equal(answered.get('t1'), 5000, 'followed the continuation token');
  // Never recorded at all, so it can't suppress anything: a send we cannot
  // date must not hide a message from the digest.
  assert.equal(answered.has('t2'), false);
});
