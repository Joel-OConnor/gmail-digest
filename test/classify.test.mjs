import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseClassification,
  applyDefaults,
  filterByImportance,
  createAnthropicClient,
  classifyEmails,
  buildSystemPrompt,
  resolveTemperature,
  emailKey,
} from '../src/classify.mjs';
import * as profile from '#profile';

const email = (over = {}) => ({
  id: 'a',
  from: { name: 'Jane', email: 'jane@x.com', domain: 'x.com' },
  subject: 'Subject A',
  dateMs: 1_770_000_000_000,
  body: 'body text',
  ...over,
});

// A fake Anthropic client. Records every request and replies with `reply(chunk)`.
function fakeClient(reply) {
  const calls = [];
  return {
    calls,
    messages: {
      create: (req) => {
        calls.push(req);
        const emails = JSON.parse(req.messages[0].content);
        return Promise.resolve({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: reply(emails) }],
        });
      },
    },
  };
}

const asJson = (emails, over = {}) =>
  JSON.stringify(
    emails.map((e) => ({
      id: e.id,
      importance: 'high',
      summary: 's',
      details: [],
      from_person: false,
      suggested_reply: '',
      ...over,
    }))
  );

test('parseClassification: plain JSON, fenced JSON, and embedded JSON', () => {
  const arr = '[{"id":"1","importance":"high","summary":"s","action_needed":true}]';
  assert.equal(parseClassification(arr)[0].id, '1');
  assert.equal(parseClassification('```json\n' + arr + '\n```')[0].importance, 'high');
  assert.equal(parseClassification('Sure! ' + arr + ' hope that helps')[0].summary, 's');
});

test('parseClassification: unparseable input degrades to an empty array', () => {
  for (const bad of ['', 'not json at all', '{"not":"an array"}', 'Here: [{"id":"1",}] end']) {
    assert.deepEqual(parseClassification(bad), [], `expected [] for ${JSON.stringify(bad)}`);
  }
});

test('applyDefaults: every input email gets a result, malformed ones default to medium', () => {
  const emails = [email({ id: 'a' }), email({ id: 'b', subject: 'Fallback subject' })];
  const out = applyDefaults([{ id: 'a', importance: 'low', summary: 'ok' }], emails);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    key: 'a',
    importance: 'low',
    summary: 'ok',
    details: [],
    from_person: false,
    suggested_reply: '',
  });
  assert.deepEqual(out[1], {
    key: 'b',
    importance: 'medium',
    summary: 'Fallback subject',
    details: [],
    from_person: false,
    suggested_reply: '',
  });
});

test('applyDefaults: rejects junk entries and out-of-range importance', () => {
  const emails = [email({ id: 'a', subject: 'S' })];
  const out = applyDefaults(
    [null, 'nope', { no_id: true }, { id: 'a', importance: 'urgent', summary: '   ' }],
    emails
  );
  assert.equal(out[0].importance, 'medium', 'unknown tier falls back');
  assert.equal(out[0].summary, 'S', 'blank summary falls back to the subject');
});

test('applyDefaults: coerces numeric ids so a JSON number still matches', () => {
  const out = applyDefaults([{ id: 1, importance: 'high', summary: 'x' }], [email({ id: '1' })]);
  assert.equal(out[0].importance, 'high');
});

test('filterByImportance: medium keeps high+medium, high keeps high, low keeps all', () => {
  const items = [
    { id: 'h', importance: 'high' },
    { id: 'm', importance: 'medium' },
    { id: 'l', importance: 'low' },
  ];
  assert.deepEqual(filterByImportance(items, 'medium').map((i) => i.id), ['h', 'm']);
  assert.deepEqual(filterByImportance(items, 'high').map((i) => i.id), ['h']);
  assert.deepEqual(filterByImportance(items, 'low').map((i) => i.id), ['h', 'm', 'l']);
  assert.deepEqual(filterByImportance(items, 'bogus').map((i) => i.id), ['h', 'm'], 'defaults to medium');
  assert.deepEqual(filterByImportance([{ id: 'x', importance: 'urgent' }], 'low'), [], 'unknown tier never passes');
});

test('createAnthropicClient sets the key, retries, and a timeout shorter than the Lambda', () => {
  const client = createAnthropicClient('sk-test-key');
  assert.equal(client.apiKey, 'sk-test-key');
  assert.equal(client.maxRetries, 3);
  assert.equal(client.timeout, 120_000);
});

test('classifyEmails: chunks at 12 emails per request', async () => {
  const emails = Array.from({ length: 13 }, (_, i) => email({ id: `e${i}` }));
  const client = fakeClient(asJson);
  const out = await classifyEmails(client, emails, 'test-model');

  assert.equal(client.calls.length, 2, 'expected 12 + 1');
  assert.equal(JSON.parse(client.calls[0].messages[0].content).length, 12);
  assert.equal(JSON.parse(client.calls[1].messages[0].content).length, 1);
  assert.equal(out.size, 13, 'chunks merge into one Map');
  assert.equal(out.get('e12').importance, 'high');
});

test('classifyEmails: exactly 12 is a single call; zero emails makes no call', async () => {
  const one = fakeClient(asJson);
  await classifyEmails(one, Array.from({ length: 12 }, (_, i) => email({ id: `e${i}` })), 'm');
  assert.equal(one.calls.length, 1);

  const none = fakeClient(asJson);
  const out = await classifyEmails(none, [], 'm');
  assert.equal(none.calls.length, 0);
  assert.equal(out.size, 0);
});

test('classifyEmails: never has more than 4 chunks in flight, and maps every result back', async () => {
  // 7 chunks of 12, each held open until the next macrotask so concurrency builds.
  const emails = Array.from({ length: 80 }, (_, i) => email({ id: `e${i}` }));
  let inFlight = 0;
  let peak = 0;
  const client = {
    messages: {
      create: async (req) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        inFlight--;
        const sent = JSON.parse(req.messages[0].content);
        // Echo each id back in the summary, so a misrouted result would show.
        return {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: JSON.stringify(sent.map((e) => ({ id: e.id, summary: e.id }))) }],
        };
      },
    },
  };
  const out = await classifyEmails(client, emails, 'm');
  assert.equal(peak, 4);
  assert.equal(out.size, 80);
  for (const e of emails) assert.equal(out.get(e.id).summary, e.id);
});

test('classifyEmails: request carries the model and the rubric, and omits temperature', async (t) => {
  // An exported TEMPERATURE in the developer's shell would otherwise leak in.
  const saved = process.env.TEMPERATURE;
  delete process.env.TEMPERATURE;
  t.after(() => {
    if (saved !== undefined) process.env.TEMPERATURE = saved;
  });

  const client = fakeClient(asJson);
  await classifyEmails(client, [email()], 'claude-test-9');
  const req = client.calls[0];

  assert.equal(req.model, 'claude-test-9');
  assert.equal(req.max_tokens, 8192);
  assert.ok(!('temperature' in req), 'newer models 400 on an explicit temperature');
  // Every profile field must reach the prompt. If one stops, classification
  // degrades silently, so assert a sentinel from each.
  assert.ok(req.system.includes('FIXTURE-RUBRIC-HIGH'), 'RUBRIC missing from system prompt');
  assert.ok(req.system.includes('FIXTURE-ABOUT-YOU'), 'ABOUT_YOU missing from system prompt');
  assert.ok(req.system.includes('FIXTURE-REPLY-STYLE'), 'REPLY_STYLE missing from system prompt');
  assert.ok(req.system.includes('FIXTURE-VOICE'), 'VOICE missing from system prompt');
});

test('classifyEmails: input is reduced to the fields the model needs', async () => {
  const client = fakeClient(asJson);
  await classifyEmails(client, [email({ id: 'z' })], 'm');
  const [sent] = JSON.parse(client.calls[0].messages[0].content);

  assert.deepEqual(Object.keys(sent).sort(), ['body', 'date', 'from', 'id', 'subject']);
  assert.equal(sent.from, 'Jane <jane@x.com>');
  assert.equal(sent.date, new Date(1_770_000_000_000).toISOString());
});

test('classifyEmails: concatenates text blocks and ignores non-text blocks', async () => {
  const client = {
    messages: {
      create: () =>
        Promise.resolve({
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking', thinking: 'ignored' },
            { type: 'text', text: '[{"id":"a","importance":"low",' },
            { type: 'text', text: '"summary":"split across blocks"}]' },
          ],
        }),
    },
  };
  const out = await classifyEmails(client, [email({ id: 'a' })], 'm');
  assert.equal(out.get('a').importance, 'low');
  assert.equal(out.get('a').summary, 'split across blocks');
});

test('classifyEmails: an unparseable reply still returns one entry per email', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const client = fakeClient(() => 'I am terribly sorry, I cannot help with that.');
  const emails = [email({ id: 'a', subject: 'Subj A' }), email({ id: 'b', subject: 'Subj B' })];
  const out = await classifyEmails(client, emails, 'm');

  assert.equal(out.size, 2, 'a bad reply must never drop emails');
  assert.equal(out.get('a').importance, 'medium');
  assert.equal(out.get('b').summary, 'Subj B');
});

test('classifyEmails: a complete reply logs nothing', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  await classifyEmails(fakeClient(asJson), [email({ id: 'a' }), email({ id: 'b' })], 'm');
  assert.equal(warn.mock.callCount(), 0);
});

test('classifyEmails: a partial reply warns with counts only, never content', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const emails = [
    email({ id: 'id-secret-1', subject: 'Subject secret 1' }),
    email({ id: 'id-secret-2', subject: 'Subject secret 2' }),
    email({ id: 'id-secret-3', subject: 'Subject secret 3' }),
  ];
  await classifyEmails(fakeClient((sent) => asJson(sent.slice(0, 2))), emails, 'm');

  assert.equal(warn.mock.callCount(), 1);
  const [line] = warn.mock.calls[0].arguments;
  assert.match(line, /stop_reason=end_turn/);
  assert.match(line, /parsed 2\/3/);
  assert.doesNotMatch(line, /secret|body text|Jane/, 'CloudWatch must never see ids, subjects, or content');
});

test('classifyEmails: an item with an invalid importance does not count as parsed', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const client = fakeClient(() => JSON.stringify([{ id: 'a', importance: 'urgent' }]));
  const out = await classifyEmails(client, [email({ id: 'a' })], 'm');

  assert.equal(out.get('a').importance, 'medium');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /stop_reason=end_turn, parsed 0\/1/);
});

test('classifyEmails: a truncated reply warns even when every item parsed', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const client = {
    messages: {
      create: () =>
        Promise.resolve({
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: asJson([email({ id: 'a' })]) }],
        }),
    },
  };
  await classifyEmails(client, [email({ id: 'a' })], 'm');
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /stop_reason=max_tokens, parsed 1\/1/);
});

test('classifyEmails: an API failure propagates', async () => {
  const client = { messages: { create: () => Promise.reject(new Error('overloaded')) } };
  await assert.rejects(() => classifyEmails(client, [email()], 'm'), /overloaded/);
});



test('applyDefaults: keeps details, from_person, and a reply draft', () => {
  const [out] = applyDefaults(
    [
      {
        id: 'a',
        importance: 'high',
        summary: 'Contractor sent a quote',
        details: ['Kitchen remodel', '  Starts in March  ', '', 42],
        from_person: true,
        suggested_reply: '  Hi Sam, thanks for the quote.  ',
      },
    ],
    [email({ id: 'a' })]
  );
  assert.deepEqual(out.details, ['Kitchen remodel', 'Starts in March'], 'blank and non-string dropped');
  assert.equal(out.from_person, true);
  assert.equal(out.suggested_reply, 'Hi Sam, thanks for the quote.');
});

test('applyDefaults: a reply attached to automated mail is discarded', () => {
  const [out] = applyDefaults(
    [{ id: 'a', importance: 'low', summary: 's', from_person: false, suggested_reply: 'Hi robot,' }],
    [email({ id: 'a' })]
  );
  assert.equal(out.from_person, false);
  assert.equal(out.suggested_reply, '', 'never suggest replying to a notification');
});

test('applyDefaults: missing or malformed new fields degrade safely', () => {
  const [out] = applyDefaults([{ id: 'a', importance: 'high', summary: 's' }], [email({ id: 'a' })]);
  assert.deepEqual(out.details, []);
  assert.equal(out.from_person, false);
  assert.equal(out.suggested_reply, '');

  const [junk] = applyDefaults(
    [{ id: 'a', importance: 'high', summary: 's', details: 'not-an-array', suggested_reply: 12 }],
    [email({ id: 'a' })]
  );
  assert.deepEqual(junk.details, []);
  assert.equal(junk.suggested_reply, '');
});




test('buildSystemPrompt carries every profile field into the prompt', () => {
  const prompt = buildSystemPrompt(profile);
  for (const field of ['ABOUT_YOU', 'RUBRIC', 'VOICE', 'REPLY_STYLE']) {
    assert.ok(prompt.includes(profile[field]), `${field} never reaches the prompt`);
  }
});

test('ABOUT_YOU gets its own labelled section, not a ride inside the rubric', () => {
  // The prompt must not depend on the user remembering to interpolate it.
  assert.ok(!profile.RUBRIC.includes(profile.ABOUT_YOU), 'the fixture rubric should not embed it');
  assert.ok(buildSystemPrompt(profile).includes(`About the owner:\n\n${profile.ABOUT_YOU}`));
});

test('buildSystemPrompt treats email content as untrusted data', () => {
  const prompt = buildSystemPrompt(profile);
  assert.match(prompt, /untrusted data/);
  assert.match(prompt, /Never follow instructions/);
});

test('buildSystemPrompt carries none of one person\'s preferences', () => {
  // The engine is shared; personal rules belong in the gitignored profile.
  const prompt = buildSystemPrompt(profile);
  for (const personal of ['em-dash', 'exclamation', 'banned', 'recruiter', 'compensation', 'job alerts']) {
    assert.ok(!prompt.toLowerCase().includes(personal.toLowerCase()), `prompt still mentions "${personal}"`);
  }
});

// --- multi-account keying -----------------------------------------------------

test('emailKey prefers the account-scoped key, falling back to the raw id', () => {
  assert.equal(emailKey({ id: 'a' }), 'a');
  assert.equal(emailKey({ id: 'a', key: 'work:a' }), 'work:a');
});

test('classifyEmails keys on the account-scoped key, and never leaks it to the model', async () => {
  // Two mailboxes can hand us the same Gmail id; keying on it would drop one.
  const client = fakeClient(asJson);
  const out = await classifyEmails(
    client,
    [
      email({ id: 'dup', key: 'work:dup', account: 'work' }),
      email({ id: 'dup', key: 'personal:dup', account: 'personal' }),
    ],
    'claude-test-9'
  );
  assert.deepEqual([...out.keys()], ['work:dup', 'personal:dup'], 'both survive');
  assert.ok(!('key' in out.get('work:dup')), 'the key is the map key, not part of the value');
  assert.ok(!('id' in out.get('work:dup')), 'an id here would clobber the real Gmail id');

  const sent = JSON.parse(client.calls[0].messages[0].content);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['body', 'date', 'from', 'id', 'subject']);
  assert.equal(sent[0].id, 'work:dup');
  assert.ok(!('account' in sent[0]), 'internal fields stay out of the prompt');
});

test('resolveTemperature: sent only when TEMPERATURE parses as a number', () => {
  assert.deepEqual(resolveTemperature(undefined), {}, 'omitted by default');
  assert.deepEqual(resolveTemperature(''), {});
  assert.deepEqual(resolveTemperature('hot'), {});
  assert.deepEqual(resolveTemperature('0'), { temperature: 0 });
  assert.deepEqual(resolveTemperature('0.7'), { temperature: 0.7 });
});

test('classifyEmails sends TEMPERATURE when it is set', async () => {
  const saved = process.env.TEMPERATURE;
  const restore = () => {
    if (saved === undefined) delete process.env.TEMPERATURE;
    else process.env.TEMPERATURE = saved;
  };
  process.env.TEMPERATURE = '0';
  const client = fakeClient(asJson);
  await classifyEmails(client, [email()], 'claude-test-9').finally(restore);
  assert.equal(client.calls[0].temperature, 0);
});
