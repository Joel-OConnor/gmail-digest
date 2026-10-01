import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handler,
  runDigest,
  sanitizeError,
  resolveMinImportance,
  resolveMaxEmails,
  resolveLookbackHours,
} from '../src/handler.mjs';

const WINDOW_END = '2026-07-26T16:00:00.000Z';
const CHECKPOINT = '2026-07-26T10:00:00.000Z';

const email = (over = {}) => ({
  id: 'a',
  from: { name: 'Jane', email: 'jane@x.com', domain: 'x.com' },
  subject: 'Subject A',
  dateMs: Date.parse(CHECKPOINT) + 1000,
  body: 'body',
  ...over,
});

/**
 * Build a fully-faked dependency set plus a `log` of what was called, so tests
 * can assert on side effects (did we send? did the checkpoint move?).
 */
function harness({
  emails = [email()],
  classify,
  checkpoint = CHECKPOINT,
  overflow = {},
  accounts = [{ name: 'personal', refreshToken: 'refresh' }],
  addresses = { refresh: 'me@example.com' },
} = {}) {
  const log = [];
  const deps = {
    loadConfig: () => {
      log.push('loadConfig');
      return Promise.resolve({
        googleClientId: 'id',
        googleClientSecret: 'secret',
        anthropicApiKey: 'sk-test',
        checkpoint,
        accounts,
      });
    },
    saveCheckpoint: (value) => {
      log.push(`saveCheckpoint:${value}`);
      return Promise.resolve();
    },
    createGmailClient: ({ refreshToken }) => {
      log.push(`createGmailClient:${refreshToken}`);
      return { fake: 'gmail', refreshToken };
    },
    authenticatedAddress: (client) => {
      log.push(`authenticatedAddress:${client.refreshToken}`);
      return Promise.resolve(addresses[client.refreshToken]);
    },
    fetchNewEmails: (client, args) => {
      log.push('fetchNewEmails');
      deps.fetchArgs = args;
      const perAccount = Array.isArray(emails) ? emails : emails[client.refreshToken];
      return Promise.resolve({
        emails: perAccount ?? [],
        overflowCount: 0,
        overflowIsAtLeast: false,
        answeredCount: 0,
        ...overflow,
      });
    },
    createAnthropicClient: () => {
      log.push('createAnthropicClient');
      return { fake: 'anthropic' };
    },
    classifyEmails: (_client, list) => {
      log.push('classifyEmails');
      const entries = list.map((e) => [e.key, classify?.(e) ?? { importance: 'high', summary: 's' }]);
      return Promise.resolve(new Map(entries));
    },
    sendDigest: (_client, payload) => {
      log.push('sendDigest');
      deps.sent = payload;
      return Promise.resolve();
    },
  };
  return { deps, log };
}

// Everything handler, classify, and ssm read from the environment. Cleared
// before each test so a value exported in the shell can't change the outcome.
const ENV_KEYS = [
  'DRY_RUN',
  'LOOKBACK_HOURS',
  'MIN_IMPORTANCE',
  'SCAN_SCOPE',
  'MAX_EMAILS',
  'TIMEZONE',
  'MODEL',
  'TEMPERATURE',
  'AWS_LAMBDA_FUNCTION_NAME',
  'ACCOUNTS',
  'SSM_PREFIX',
  'DIGEST_RECIPIENT',
];

// Every test controls the environment explicitly; restore it afterwards.
function withEnv(vars, fn) {
  const saved = { ...process.env };
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, { DIGEST_RECIPIENT: 'me@example.com', ...vars });
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k];
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    });
}

const event = { scheduledTime: WINDOW_END };

// --- happy path --------------------------------------------------------------

test('sends a digest, then advances the checkpoint to the window end', async () => {
  await withEnv({}, async () => {
    const { deps, log } = harness();
    const result = await runDigest(event, deps);

    assert.deepEqual(result, { status: 'sent', emails: 1, shown: 1, high: 1, filtered: 0, answered: 0 });
    assert.deepEqual(
      log.filter((l) => l === 'sendDigest' || l.startsWith('saveCheckpoint')),
      ['sendDigest', `saveCheckpoint:${WINDOW_END}`],
      'checkpoint must only move after a successful send'
    );
    assert.equal(deps.sent.to, 'me@example.com');
    assert.equal(deps.sent.from, 'me@example.com', 'From must be an address the token can send as');
    assert.match(deps.sent.subject, /^\[Inbox Digest\]/);
    assert.match(deps.sent.html, /Subject A/);
  });
});

test('uses the scheduled fire time as the window end', async () => {
  await withEnv({}, async () => {
    const { deps } = harness();
    await runDigest(event, deps);
    assert.equal(deps.fetchArgs.untilMs, Date.parse(WINDOW_END));
    assert.equal(deps.fetchArgs.sinceMs, Date.parse(CHECKPOINT));
  });
});

test('falls back to "now" when the event carries no usable scheduledTime', async () => {
  for (const bad of [{}, { scheduledTime: 'not-a-date' }, undefined]) {
    await withEnv({}, async () => {
      const before = Date.now();
      // A long-past checkpoint, so "now" as the window end still opens a window.
      const { deps } = harness({ checkpoint: '2020-01-01T00:00:00.000Z' });
      await runDigest(bad, deps);
      assert.ok(deps.fetchArgs.untilMs >= before, `fallback failed for ${JSON.stringify(bad)}`);
    });
  }
});

// --- idempotency -------------------------------------------------------------

test('skips entirely when the checkpoint already covers the window end', async () => {
  await withEnv({}, async () => {
    const { deps, log } = harness({ checkpoint: WINDOW_END });
    const result = await runDigest(event, deps);

    assert.deepEqual(result, { status: 'skipped' });
    assert.deepEqual(log, ['loadConfig'], 'must not touch Gmail, Claude, or the checkpoint');
  });
});

test('a checkpoint one millisecond short of the window still runs', async () => {
  await withEnv({}, async () => {
    const almost = new Date(Date.parse(WINDOW_END) - 1).toISOString();
    const { log } = harness({ checkpoint: almost });
    const { deps } = harness({ checkpoint: almost });
    await runDigest(event, deps);
    assert.ok(!log.includes('skipped'));
    assert.equal((await runDigest(event, deps)).status, 'sent');
  });
});

test('a missing checkpoint falls back to an 18-hour lookback', async () => {
  await withEnv({}, async () => {
    const { deps } = harness({ checkpoint: null });
    await runDigest(event, deps);
    assert.equal(deps.fetchArgs.sinceMs, Date.parse(WINDOW_END) - 18 * 60 * 60 * 1000);
  });
});

test('an unparseable checkpoint fails loudly rather than digesting the wrong window', async () => {
  await withEnv({}, async () => {
    const { deps, log } = harness({ checkpoint: 'yesterday' });
    await assert.rejects(() => runDigest(event, deps), /Unparseable checkpoint: yesterday/);
    assert.ok(!log.some((l) => l.startsWith('saveCheckpoint')));
  });
});

// --- failure never advances the checkpoint -----------------------------------

for (const failing of ['fetchNewEmails', 'classifyEmails', 'sendDigest', 'loadConfig']) {
  test(`a failure in ${failing} leaves the checkpoint untouched`, async () => {
    await withEnv({}, async () => {
      const { deps, log } = harness();
      deps[failing] = () => Promise.reject(new Error(`${failing} exploded`));
      await assert.rejects(() => runDigest(event, deps), new RegExp(`${failing} exploded`));
      assert.ok(
        !log.some((l) => l.startsWith('saveCheckpoint')),
        'checkpoint moved despite a failure — the window would be lost'
      );
    });
  });
}

// --- non-sending outcomes ----------------------------------------------------

test('zero new emails: no send, but the checkpoint advances', async () => {
  await withEnv({}, async () => {
    const { deps, log } = harness({ emails: [] });
    const result = await runDigest(event, deps);

    assert.deepEqual(result, { status: 'empty' });
    assert.ok(!log.includes('sendDigest'));
    assert.ok(!log.includes('createAnthropicClient'), 'no reason to pay for classification');
    assert.ok(log.includes(`saveCheckpoint:${WINDOW_END}`));
  });
});

test('nothing above the threshold: no send, checkpoint advances, count reported', async () => {
  await withEnv({ MIN_IMPORTANCE: 'high' }, async () => {
    const { deps, log } = harness({
      emails: [email({ id: 'a' }), email({ id: 'b' })],
      classify: (e) => ({ id: e.id, importance: 'low', summary: 's' }),
    });
    const result = await runDigest(event, deps);

    assert.deepEqual(result, { status: 'nothing-important', filtered: 2 });
    assert.ok(!log.includes('sendDigest'));
    assert.ok(log.includes(`saveCheckpoint:${WINDOW_END}`));
  });
});

test('no emails but some overflow: the overflow alone is sent, unclassified', async () => {
  // Without this, the checkpoint moves past mail nobody was ever told about.
  await withEnv({}, async () => {
    const { deps, log } = harness({ emails: [], overflow: { overflowCount: 4 } });
    const result = await runDigest(event, deps);

    assert.deepEqual(result, { status: 'sent', emails: 0, shown: 0, high: 0, filtered: 0, answered: 0 });
    assert.ok(!log.includes('createAnthropicClient'), 'nothing to classify');
    assert.ok(!log.includes('classifyEmails'));
    assert.match(deps.sent.html, /4 additional emails/);
    assert.ok(log.includes(`saveCheckpoint:${WINDOW_END}`));
  });
});

test('nothing above the threshold but some overflow: the overflow is still sent', async () => {
  await withEnv({ MIN_IMPORTANCE: 'high' }, async () => {
    const { deps, log } = harness({
      classify: (e) => ({ id: e.id, importance: 'low', summary: 'SENTINEL-LOW' }),
      overflow: { overflowCount: 2, overflowIsAtLeast: true },
    });
    const result = await runDigest(event, deps);

    assert.deepEqual(result, { status: 'sent', emails: 1, shown: 0, high: 0, filtered: 1, answered: 0 });
    assert.match(deps.sent.html, /at least 2 additional emails/);
    assert.match(deps.sent.html, /1 low-priority email left out/);
    assert.ok(!deps.sent.html.includes('SENTINEL-LOW'), 'filtered mail stays out');
    assert.ok(log.includes(`saveCheckpoint:${WINDOW_END}`));
  });
});

test('DRY_RUN renders but never sends and never advances the checkpoint', async () => {
  await withEnv({ DRY_RUN: 'true' }, async () => {
    const { deps, log } = harness();
    const result = await runDigest(event, deps);

    assert.equal(result.status, 'dry-run');
    assert.ok(!log.includes('sendDigest'));
    assert.ok(!log.some((l) => l.startsWith('saveCheckpoint')));
  });
});

test('DRY_RUN also withholds the checkpoint on the empty and filtered paths', async () => {
  await withEnv({ DRY_RUN: 'true' }, async () => {
    const empty = harness({ emails: [] });
    await runDigest(event, empty.deps);
    assert.ok(!empty.log.some((l) => l.startsWith('saveCheckpoint')));
  });
  await withEnv({ DRY_RUN: 'true', MIN_IMPORTANCE: 'high' }, async () => {
    const filtered = harness({
      classify: (e) => ({ id: e.id, importance: 'low', summary: 's' }),
    });
    await runDigest(event, filtered.deps);
    assert.ok(!filtered.log.some((l) => l.startsWith('saveCheckpoint')));
  });
});

// --- configuration -----------------------------------------------------------

test('MIN_IMPORTANCE filters what reaches the digest, and counts report both totals', async () => {
  await withEnv({ MIN_IMPORTANCE: 'high' }, async () => {
    const { deps } = harness({
      emails: [email({ id: 'hi' }), email({ id: 'lo' })],
      classify: (e) => ({
        id: e.id,
        importance: e.id === 'hi' ? 'high' : 'low',
        summary: 's',
        action_needed: false,
      }),
    });
    const result = await runDigest(event, deps);

    assert.deepEqual(result, { status: 'sent', emails: 2, shown: 1, high: 1, filtered: 1, answered: 0 });
    assert.match(deps.sent.subject, /\(1 emails, 1 high\)/, 'subject counts what is shown');
    assert.match(deps.sent.html, /1 low-priority email left out/);
  });
});

test('SCAN_SCOPE only accepts the exact string "arrived"', async () => {
  for (const [value, expected] of [
    ['arrived', 'arrived'],
    ['ARRIVED', 'inbox'],
    ['inbox', 'inbox'],
    [undefined, 'inbox'],
  ]) {
    await withEnv({ SCAN_SCOPE: value }, async () => {
      const { deps } = harness();
      await runDigest(event, deps);
      assert.equal(deps.fetchArgs.scope, expected, `SCAN_SCOPE=${value}`);
    });
  }
});

test('MAX_EMAILS and TIMEZONE reach the places that use them', async () => {
  await withEnv({ MAX_EMAILS: '7', TIMEZONE: 'Asia/Tokyo' }, async () => {
    const { deps } = harness();
    await runDigest(event, deps);
    assert.equal(deps.fetchArgs.maxEmails, 7);
    // 16:00Z is 01:00 next-day in Tokyo -> Morning, and the date rolls over.
    assert.match(deps.sent.subject, /Mon Jul 27 — Morning/);
  });
});

test('MODEL is passed through to the classifier, defaulting when unset', async () => {
  await withEnv({ MODEL: 'claude-test-model' }, async () => {
    const { deps } = harness();
    let seen;
    const inner = deps.classifyEmails;
    deps.classifyEmails = (client, list, model) => {
      seen = model;
      return inner(client, list, model);
    };
    await runDigest(event, deps);
    assert.equal(seen, 'claude-test-model');
  });

  await withEnv({ MODEL: undefined }, async () => {
    const { deps } = harness();
    let seen;
    const inner = deps.classifyEmails;
    deps.classifyEmails = (client, list, model) => {
      seen = model;
      return inner(client, list, model);
    };
    await runDigest(event, deps);
    assert.equal(seen, 'claude-sonnet-4-6');
  });
});

test('a missing DIGEST_RECIPIENT fails before any network call', async () => {
  await withEnv({ DIGEST_RECIPIENT: undefined }, async () => {
    const { deps, log } = harness();
    await assert.rejects(() => runDigest(event, deps), /DIGEST_RECIPIENT/);
    assert.deepEqual(log, [], 'must not even load config');
  });
});

test('already-answered mail is reported and noted in the digest', async () => {
  await withEnv({}, async () => {
    const { deps } = harness({ overflow: { answeredCount: 3 } });
    const result = await runDigest(event, deps);
    assert.equal(result.answered, 3);
    assert.match(deps.sent.html, /3 already answered emails left out/);
  });
});

test('overflow is surfaced in the digest, as a floor or an exact count', async () => {
  await withEnv({}, async () => {
    const { deps } = harness({ overflow: { overflowCount: 5, overflowIsAtLeast: true } });
    await runDigest(event, deps);
    assert.match(deps.sent.html, /at least 5 additional emails/);
  });

  await withEnv({}, async () => {
    const { deps } = harness({ overflow: { overflowCount: 5, overflowIsAtLeast: false } });
    await runDigest(event, deps);
    assert.match(deps.sent.html, /5 additional emails/);
    assert.ok(!deps.sent.html.includes('at least'));
  });
});

test('an email the classifier omitted is dropped rather than crashing the run', async () => {
  await withEnv({}, async () => {
    const { deps } = harness({ emails: [email({ id: 'a' }), email({ id: 'ghost' })] });
    deps.classifyEmails = () =>
      Promise.resolve(new Map([['personal:a', { importance: 'high', summary: 's' }]]));
    const result = await runDigest(event, deps);
    assert.equal(result.shown, 1, 'the unclassified email has no tier, so it is filtered out');
  });
});

// --- privacy -----------------------------------------------------------------

test('logs carry counts only — never subjects, senders, or bodies', async (t) => {
  await withEnv({}, async () => {
    const lines = [];
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    const { deps } = harness({
      emails: [email({ subject: 'SENTINEL-SUBJECT', body: 'SENTINEL-BODY' })],
      classify: (e) => ({ id: e.id, importance: 'high', summary: 'SENTINEL-SUMMARY' }),
    });
    await runDigest(event, deps);

    const joined = lines.join('\n');
    for (const sentinel of ['SENTINEL-SUBJECT', 'SENTINEL-BODY', 'SENTINEL-SUMMARY']) {
      assert.ok(!joined.includes(sentinel), `${sentinel} leaked into the logs`);
    }
  });
});

test('DRY_RUN prints the digest locally — that is the point of a dry run', async (t) => {
  await withEnv({ DRY_RUN: 'true', AWS_LAMBDA_FUNCTION_NAME: undefined }, async () => {
    const lines = [];
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    const { deps } = harness({ emails: [email({ subject: 'SENTINEL-SUBJECT' })] });
    await runDigest(event, deps);
    assert.ok(lines.join('\n').includes('SENTINEL-SUBJECT'));
  });
});

test('DRY_RUN inside Lambda withholds the body, which CloudWatch would keep', async (t) => {
  await withEnv({ DRY_RUN: 'true', AWS_LAMBDA_FUNCTION_NAME: 'gmail-digest' }, async () => {
    const lines = [];
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    const { deps } = harness({ emails: [email({ subject: 'SENTINEL-SUBJECT' })] });
    const result = await runDigest(event, deps);
    const logged = lines.join('\n');
    assert.equal(result.status, 'dry-run');
    assert.ok(!logged.includes('SENTINEL-SUBJECT'), 'no mail content reaches the log');
    assert.match(logged, /digest body withheld/);
  });
});

// --- error sanitising --------------------------------------------------------

test('sanitizeError strips every enumerable property that could hold email content', () => {
  const leaky = new Error('Request failed');
  leaky.status = 500;
  leaky.config = { data: { raw: 'BASE64-DIGEST-SENTINEL' } };
  leaky.response = { data: { html: '<p>SENTINEL</p>' } };

  const clean = sanitizeError(leaky);
  assert.equal(Object.keys(clean).length, 0, 'no enumerable properties may survive');
  assert.ok(!JSON.stringify(clean).includes('SENTINEL'));
  assert.ok(!clean.message.includes('SENTINEL'));
  assert.match(clean.message, /status 500/);
  assert.equal(clean.stack, leaky.stack, 'the stack is kept for debugging');
});

test('sanitizeError falls back through status sources', () => {
  assert.match(sanitizeError({ message: 'a', status: 1 }).message, /status 1/);
  assert.match(sanitizeError({ message: 'a', response: { status: 2 } }).message, /status 2/);
  assert.match(sanitizeError({ message: 'a', code: 'ECONN' }).message, /status ECONN/);
  assert.match(sanitizeError({ message: 'a' }).message, /status n\/a/);
});

test('sanitizeError appends the fix for the recurring auth failures', () => {
  const scopes = sanitizeError(new Error('Request had insufficient authentication scopes.'));
  assert.match(scopes.message, /lacks gmail\.send\. Run `npm run add-account <name>` and tick every/);
  const revoked = sanitizeError(new Error('invalid_grant: Token has been expired or revoked.'));
  assert.match(revoked.message, /revoked \(a Google password change does this\)/);
  assert.match(revoked.message, /Re-authorise with `npm run add-account <name>`/);
  const client = sanitizeError(new Error('invalid_client'));
  assert.match(client.message, /client ID or secret stored in SSM is wrong/);
  assert.match(client.message, /`npm run setup -- --force`/);
  for (const msg of [scopes.message, revoked.message, client.message]) {
    // Neither the old script path nor the legacy single-account parameter is
    // what a multi-account install should touch.
    assert.ok(!msg.includes('get-refresh-token'), msg);
    assert.ok(!msg.includes('google-refresh-token'), msg);
  }
  assert.ok(!sanitizeError(new Error('something else')).message.includes('add-account'));
});

test('sanitizeError names the failing account, in the message and in the fix', () => {
  const err = new Error('invalid_grant');
  err.account = 'work';
  err.status = 400;
  const clean = sanitizeError(err);
  assert.match(clean.message, /\(status 400, account work\)/);
  assert.match(clean.message, /`npm run add-account work`/);
  assert.equal(Object.keys(clean).length, 0, 'the tag does not survive as a property');
});

test('sanitizeError copes with non-Error throws', () => {
  assert.match(sanitizeError('boom').message, /Error \(status n\/a\): boom/);
  assert.doesNotThrow(() => sanitizeError(undefined));
});

test('runDigest routes failures through the sanitizer', async () => {
  await withEnv({}, async () => {
    const { deps } = harness();
    const leaky = new Error('nope');
    leaky.config = { data: 'SENTINEL' };
    deps.loadConfig = () => Promise.reject(leaky);

    const err = await runDigest(event, deps).then(
      () => null,
      (e) => e
    );
    assert.ok(err, 'expected a rejection');
    assert.equal(Object.keys(err).length, 0);
  });
});

test('every successful run logs its status, so CloudWatch can be searched for it', async (t) => {
  for (const [opts, env, status] of [
    [{}, {}, 'sent'],
    [{ checkpoint: WINDOW_END }, {}, 'skipped'],
    [{ emails: [] }, {}, 'empty'],
    [{}, { DRY_RUN: 'true' }, 'dry-run'],
  ]) {
    await withEnv(env, async () => {
      const lines = [];
      const mock = t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
      const result = await runDigest(event, harness(opts).deps);
      mock.mock.restore();
      assert.equal(result.status, status);
      assert.equal(lines.at(-1), `Run finished: status=${status}`);
    });
  }
});

test('a failed run logs no status line', async (t) => {
  await withEnv({}, async () => {
    const lines = [];
    t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
    const { deps } = harness();
    deps.loadConfig = () => Promise.reject(new Error('nope'));
    await assert.rejects(() => runDigest(event, deps));
    assert.ok(!lines.some((l) => l.startsWith('Run finished')));
  });
});

test('a checkpoint write that fails after sending does not throw, so Lambda will not resend', async (t) => {
  await withEnv({}, async () => {
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
    const { deps, log } = harness({
      emails: [email({ subject: 'SENTINEL-SUBJECT' })],
      classify: () => ({ importance: 'high', summary: 'SENTINEL-SUMMARY' }),
    });
    const leaky = new Error('ThrottlingException');
    leaky.config = { data: 'SENTINEL-CONFIG' };
    deps.saveCheckpoint = () => Promise.reject(leaky);

    const result = await runDigest(event, deps);
    assert.deepEqual(result, {
      status: 'sent-checkpoint-stale',
      emails: 1,
      shown: 1,
      high: 1,
      filtered: 0,
      answered: 0,
    });
    assert.ok(log.includes('sendDigest'));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /next digest will repeat these emails/);
    assert.match(errors[0], /ThrottlingException/);
    assert.ok(!errors[0].includes('\n'), 'one line');
    for (const sentinel of ['SENTINEL-SUBJECT', 'SENTINEL-SUMMARY', 'SENTINEL-CONFIG']) {
      assert.ok(!errors[0].includes(sentinel), `${sentinel} leaked into the error log`);
    }
  });
});

test('a mailbox that fails to authenticate or fetch is named in the error', async () => {
  for (const failing of ['authenticatedAddress', 'fetchNewEmails']) {
    await withEnv({}, async () => {
      const { deps } = harness(twoAccounts);
      deps[failing] = (client) =>
        client.refreshToken === 'personal-tok'
          ? Promise.reject(new Error('invalid_grant'))
          : Promise.resolve(failing === 'authenticatedAddress' ? 'me@work.com' : { emails: [] });
      await assert.rejects(() => runDigest(event, deps), (err) => {
        assert.match(err.message, /account personal/, failing);
        assert.match(err.message, /npm run add-account personal/, failing);
        return true;
      });
    });
  }
});

test('a send failure names the mailbox it was sent from', async () => {
  await withEnv({ DIGEST_RECIPIENT: 'me@personal.com' }, async () => {
    const { deps } = harness(twoAccounts);
    deps.sendDigest = () =>
      Promise.reject(new Error('Request had insufficient authentication scopes.'));
    await assert.rejects(
      () => runDigest(event, deps),
      /account personal\).*npm run add-account personal/
    );
  });
});

test('a non-Error throw from a mailbox is still tagged with the account', async () => {
  await withEnv({}, async () => {
    const { deps } = harness();
    deps.authenticatedAddress = () => Promise.reject('socket hang up'); // eslint-disable-line prefer-promise-reject-errors
    await assert.rejects(() => runDigest(event, deps), /account personal\): socket hang up/);
  });
});

test('the exported Lambda handler wraps runDigest with the real dependencies', async () => {
  // Guard clause fires before any client is constructed, so this exercises the
  // production entrypoint without touching AWS, Gmail, or Anthropic.
  await withEnv({ DIGEST_RECIPIENT: undefined }, async () => {
    await assert.rejects(() => handler({}), /DIGEST_RECIPIENT env var is required/);
  });
});

// --- env parsing -------------------------------------------------------------

test('resolveMinImportance accepts only the three real tiers', () => {
  assert.equal(resolveMinImportance('high'), 'high');
  assert.equal(resolveMinImportance('medium'), 'medium');
  assert.equal(resolveMinImportance('low'), 'low');
  for (const bad of [undefined, '', 'HIGH', 'everything', 'toString', 'constructor', '__proto__']) {
    assert.equal(resolveMinImportance(bad), 'medium', `MIN_IMPORTANCE=${bad} must not be accepted`);
  }
});

test('resolveMaxEmails rejects zero, negatives, and garbage', (t) => {
  const logged = [];
  t.mock.method(console, 'log', (...args) => logged.push(args.join(' ')));
  assert.equal(resolveMaxEmails('50'), 50);
  assert.equal(resolveMaxEmails(' 50 '), 50, 'surrounding whitespace is harmless');
  for (const bad of [undefined, '', '0', '-5', 'unlimited']) {
    assert.equal(resolveMaxEmails(bad), 100, `MAX_EMAILS=${bad} must fall back`);
  }
  // parseInt would read these as 1, 10, 2, and 1 respectively.
  for (const bad of ['1,000', '10abc', '2.5', '1e3', '99999999999999999999']) {
    assert.equal(resolveMaxEmails(bad), 100, `MAX_EMAILS=${bad} must fall back`);
    assert.ok(logged.some((l) => l.includes(JSON.stringify(bad))), `MAX_EMAILS=${bad} is logged`);
  }
});

// --- multiple mailboxes -------------------------------------------------------

const twoAccounts = {
  accounts: [
    { name: 'work', refreshToken: 'work-tok' },
    { name: 'personal', refreshToken: 'personal-tok' },
  ],
  addresses: { 'work-tok': 'me@work.com', 'personal-tok': 'me@personal.com' },
};

test('every configured mailbox is fetched with its own client', async () => {
  await withEnv({}, async () => {
    const { deps, log } = harness({
      ...twoAccounts,
      emails: { 'work-tok': [email({ id: 'w1' })], 'personal-tok': [email({ id: 'p1' })] },
    });
    const result = await runDigest(event, deps);

    assert.deepEqual(
      log.filter((l) => l.startsWith('createGmailClient')),
      ['createGmailClient:work-tok', 'createGmailClient:personal-tok']
    );
    assert.equal(result.emails, 2, 'both mailboxes contribute');
    assert.match(deps.sent.html, /work/, 'the account tag identifies which inbox it came from');
    assert.ok(
      deps.sent.html.includes('mail/u/me%40work.com/'),
      'links open the mailbox the email is actually in'
    );
  });
});

test('the digest is sent from the mailbox that owns the recipient address', async () => {
  await withEnv({ DIGEST_RECIPIENT: 'me@personal.com' }, async () => {
    const { deps } = harness(twoAccounts);
    await runDigest(event, deps);
    assert.equal(deps.sent.from, 'me@personal.com');
  });
});

test('the sender match ignores case and stray whitespace in DIGEST_RECIPIENT', async () => {
  await withEnv({ DIGEST_RECIPIENT: '  Me@Personal.COM ' }, async () => {
    const { deps } = harness(twoAccounts);
    await runDigest(event, deps);
    assert.equal(deps.sent.from, 'me@personal.com');
    assert.equal(deps.sent.to, '  Me@Personal.COM ', 'the recipient is used as written');
  });
});

test('a recipient outside every scanned mailbox sends from the first', async () => {
  // Sending "as" an address the token cannot send as fails DMARC, so the
  // fallback has to be a real mailbox, not the recipient.
  await withEnv({ DIGEST_RECIPIENT: 'someone@else.com' }, async () => {
    const { deps } = harness(twoAccounts);
    await runDigest(event, deps);
    assert.equal(deps.sent.from, 'me@work.com');
    assert.equal(deps.sent.to, 'someone@else.com');
  });
});

test('the same Gmail id in two mailboxes stays two emails', async () => {
  // Message ids are unique per mailbox. Keyed on the raw id, one would silently
  // overwrite the other's classification.
  await withEnv({}, async () => {
    const { deps } = harness({
      ...twoAccounts,
      emails: {
        'work-tok': [email({ id: 'dup', subject: 'From work' })],
        'personal-tok': [email({ id: 'dup', subject: 'From personal' })],
      },
      classify: (e) => ({ importance: 'high', summary: `sum:${e.key}` }),
    });
    const result = await runDigest(event, deps);
    assert.equal(result.shown, 2);
    assert.match(deps.sent.html, /sum:work:dup/);
    assert.match(deps.sent.html, /sum:personal:dup/);
  });
});

test('per-mailbox overflow and answered counts are summed', async () => {
  await withEnv({}, async () => {
    const { deps } = harness({
      ...twoAccounts,
      overflow: { overflowCount: 3, overflowIsAtLeast: true, answeredCount: 2 },
    });
    const result = await runDigest(event, deps);
    assert.equal(result.answered, 4, 'both mailboxes report their own skipped mail');
    assert.match(deps.sent.html, /at least 6 additional emails/);
  });
});

// --- lookback override --------------------------------------------------------

test('resolveLookbackHours accepts positive numbers and ignores the rest', () => {
  assert.equal(resolveLookbackHours(undefined), null);
  assert.equal(resolveLookbackHours(''), null);
  assert.equal(resolveLookbackHours('0'), null, 'zero would make an empty window');
  assert.equal(resolveLookbackHours('-3'), null);
  assert.equal(resolveLookbackHours('soon'), null);
  assert.equal(resolveLookbackHours('72'), 72);
  assert.equal(resolveLookbackHours('0.5'), 0.5);
});

test('LOOKBACK_HOURS widens the window past the checkpoint', async () => {
  await withEnv({ LOOKBACK_HOURS: '72', DRY_RUN: 'true' }, async () => {
    const { deps } = harness();
    await runDigest(event, deps);
    assert.equal(
      deps.fetchArgs.sinceMs,
      Date.parse(WINDOW_END) - 72 * 60 * 60 * 1000,
      'the checkpoint is deliberately ignored'
    );
  });
});

test('an invalid LOOKBACK_HOURS falls back to the checkpoint, not to a default window', async () => {
  await withEnv({ LOOKBACK_HOURS: 'yesterday', DRY_RUN: 'true' }, async () => {
    const { deps } = harness();
    await runDigest(event, deps);
    assert.equal(deps.fetchArgs.sinceMs, Date.parse(CHECKPOINT));
  });
});
