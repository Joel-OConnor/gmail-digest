import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, loadOAuthClient, saveCheckpoint, accountNames, tokenPath } from '../src/ssm.mjs';

const P = '/gmail-digest';

// Parameter names derive from SSM_PREFIX and the mailbox list from ACCOUNTS, so
// pin both per test rather than inherit whatever the shell exported.
const PINNED = ['SSM_PREFIX', 'ACCOUNTS'];
let savedEnv;
beforeEach(() => {
  savedEnv = Object.fromEntries(PINNED.map((k) => [k, process.env[k]]));
  process.env.SSM_PREFIX = P;
  delete process.env.ACCOUNTS;
});
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const ALL_SECRETS = {
  [`${P}/google-client-id`]: 'client-id',
  [`${P}/google-client-secret`]: 'client-secret',
  [`${P}/google-refresh-token`]: 'refresh-token',
  [`${P}/anthropic-api-key`]: 'sk-test',
};

// Fake SSM client: records commands, replies with the given parameter values.
function fakeSsm(values, { fail } = {}) {
  const commands = [];
  return {
    commands,
    send: (command) => {
      commands.push(command);
      if (fail) return Promise.reject(fail);
      if (values === undefined) return Promise.resolve({});
      const requested = command.input.Names ?? [];
      return Promise.resolve({
        Parameters: requested
          .filter((name) => name in values)
          .map((name) => ({ Name: name, Value: values[name] })),
      });
    },
  };
}

// ACCOUNTS is read per call, so each test can set its own mailbox list.
function withAccounts(value, fn) {
  const saved = process.env.ACCOUNTS;
  if (value === undefined) delete process.env.ACCOUNTS;
  else process.env.ACCOUNTS = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (saved === undefined) delete process.env.ACCOUNTS;
      else process.env.ACCOUNTS = saved;
    });
}

test('loadConfig fetches all secrets plus the checkpoint in one decrypted call', async () => {
  const ssm = fakeSsm({ ...ALL_SECRETS, [`${P}/checkpoint`]: '2026-07-26T00:00:00.000Z' });
  const config = await loadConfig(ssm);

  assert.equal(ssm.commands.length, 1, 'one round trip, not five');
  const { Names, WithDecryption } = ssm.commands[0].input;
  assert.deepEqual(Names, [
    `${P}/google-client-id`,
    `${P}/google-client-secret`,
    `${P}/anthropic-api-key`,
    `${P}/checkpoint`,
    `${P}/google-refresh-token`,
    `${P}/accounts/personal/refresh-token`,
  ]);
  assert.equal(WithDecryption, true, 'SecureStrings would come back encrypted otherwise');
  assert.deepEqual(config, {
    googleClientId: 'client-id',
    googleClientSecret: 'client-secret',
    anthropicApiKey: 'sk-test',
    checkpoint: '2026-07-26T00:00:00.000Z',
    // The legacy single-account path still resolves, which is what stops an
    // existing install breaking the day per-account paths landed.
    accounts: [{ name: 'personal', refreshToken: 'refresh-token' }],
  });
});

test('SSM_PREFIX is read at call time, so a .env loaded after import still counts', async () => {
  // scripts/get-refresh-token.mjs imports this module before it loads .env.
  process.env.SSM_PREFIX = '/other/';
  assert.equal(tokenPath('work'), '/other/accounts/work/refresh-token', 'trailing slash dropped');

  const ssm = fakeSsm({
    '/other/google-client-id': 'id',
    '/other/google-client-secret': 'secret',
    '/other/anthropic-api-key': 'key',
    '/other/checkpoint': 'cp',
    [tokenPath('personal')]: 'tok',
  });
  const config = await loadConfig(ssm);
  assert.equal(config.checkpoint, 'cp');
  assert.deepEqual(config.accounts, [{ name: 'personal', refreshToken: 'tok' }]);
  assert.deepEqual(await loadOAuthClient(ssm), { clientId: 'id', clientSecret: 'secret' });
  await saveCheckpoint('x', ssm);
  assert.equal(ssm.commands.at(-1).input.Name, '/other/checkpoint');
});

test('an unset SSM_PREFIX falls back to /gmail-digest', () => {
  delete process.env.SSM_PREFIX;
  assert.equal(tokenPath('work'), '/gmail-digest/accounts/work/refresh-token');
});

test('loadConfig splits more than 10 names across calls and merges the results', async () => {
  // GetParameters caps a request at 10 names: 5 fixed plus 8 accounts is 13.
  const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  await withAccounts(names.join(','), async () => {
    const tokens = Object.fromEntries(names.map((n) => [tokenPath(n), `${n}-token`]));
    const ssm = fakeSsm({ ...ALL_SECRETS, ...tokens });
    const config = await loadConfig(ssm);

    assert.deepEqual(
      ssm.commands.map((c) => c.input.Names.length),
      [10, 3]
    );
    assert.ok(ssm.commands.every((c) => c.input.WithDecryption === true));
    assert.equal(config.googleClientId, 'client-id');
    assert.equal(config.anthropicApiKey, 'sk-test');
    assert.deepEqual(
      config.accounts,
      names.map((name) => ({ name, refreshToken: `${name}-token` }))
    );
  });
});

test('accountNames: ACCOUNTS is split, trimmed, and deduped', async () => {
  await withAccounts(undefined, () => assert.deepEqual(accountNames(), ['personal']));
  await withAccounts('   ', () => assert.deepEqual(accountNames(), ['personal']));
  await withAccounts(' work , personal ,work,', () =>
    assert.deepEqual(accountNames(), ['work', 'personal'])
  );
});

test('loadConfig loads a refresh token per account', async () => {
  await withAccounts('work,personal', async () => {
    const ssm = fakeSsm({
      ...ALL_SECRETS,
      [tokenPath('work')]: 'work-token',
      [tokenPath('personal')]: 'personal-token',
    });
    const config = await loadConfig(ssm);
    assert.deepEqual(config.accounts, [
      { name: 'work', refreshToken: 'work-token' },
      { name: 'personal', refreshToken: 'personal-token' },
    ]);
  });
});

test('loadConfig names the account whose token is missing', async () => {
  await withAccounts('work,personal', async () => {
    const ssm = fakeSsm({ ...ALL_SECRETS, [tokenPath('work')]: 'work-token' });
    await assert.rejects(() => loadConfig(ssm), (err) => {
      assert.match(err.message, /accounts\/personal\/refresh-token/);
      assert.ok(!err.message.includes('accounts/work/'), 'should only name what is missing');
      return true;
    });
  });
});

test('the legacy token is not shared across a multi-account install', async () => {
  // Two mailboxes both reading one token would digest the same inbox twice.
  await withAccounts('work,personal', async () => {
    await assert.rejects(() => loadConfig(fakeSsm(ALL_SECRETS)), /accounts\/work\/refresh-token/);
  });
});

test('a per-account token wins over the legacy one', async () => {
  const ssm = fakeSsm({ ...ALL_SECRETS, [tokenPath('personal')]: 'new-token' });
  const config = await loadConfig(ssm);
  assert.deepEqual(config.accounts, [{ name: 'personal', refreshToken: 'new-token' }]);
});

test('loadConfig returns checkpoint: null on the very first run', async () => {
  // Protects the documented 18-hour first-run lookback in handler.mjs.
  const config = await loadConfig(fakeSsm(ALL_SECRETS));
  assert.equal(config.checkpoint, null);
});

test('loadConfig names exactly which secrets are missing', async () => {
  const { [`${P}/anthropic-api-key`]: _omitted, ...rest } = ALL_SECRETS;
  await assert.rejects(() => loadConfig(fakeSsm(rest)), (err) => {
    assert.match(err.message, /Missing required SSM parameters/);
    assert.match(err.message, /anthropic-api-key/);
    assert.ok(!err.message.includes('google-client-id'), 'should only name what is missing');
    return true;
  });
});

test('loadConfig tolerates a response with no Parameters array', async () => {
  await assert.rejects(() => loadConfig(fakeSsm(undefined)), /Missing required SSM parameters/);
});

test('loadOAuthClient requests only the two client credentials', async () => {
  const ssm = fakeSsm(ALL_SECRETS);
  const creds = await loadOAuthClient(ssm);

  assert.deepEqual(ssm.commands[0].input.Names, [
    `${P}/google-client-id`,
    `${P}/google-client-secret`,
  ]);
  assert.equal(ssm.commands[0].input.WithDecryption, true);
  assert.deepEqual(creds, { clientId: 'client-id', clientSecret: 'client-secret' });
});

test('loadOAuthClient tolerates a response with no Parameters array', async () => {
  await assert.rejects(() => loadOAuthClient(fakeSsm(undefined)), /Missing required SSM parameters/);
});

test('loadOAuthClient reports a missing credential', async () => {
  const only = { [`${P}/google-client-id`]: 'client-id' };
  await assert.rejects(() => loadOAuthClient(fakeSsm(only)), /google-client-secret/);
});

test('saveCheckpoint overwrites the plain-string checkpoint parameter', async () => {
  const ssm = fakeSsm(ALL_SECRETS);
  await saveCheckpoint('2026-07-26T16:00:00.000Z', ssm);

  assert.deepEqual(ssm.commands[0].input, {
    Name: `${P}/checkpoint`,
    Value: '2026-07-26T16:00:00.000Z',
    Type: 'String',
    // Without Overwrite every run after the first would fail.
    Overwrite: true,
  });
});

test('an SSM failure propagates out of every export', async () => {
  const boom = new Error('AccessDeniedException');
  await assert.rejects(() => loadConfig(fakeSsm(ALL_SECRETS, { fail: boom })), /AccessDenied/);
  await assert.rejects(() => loadOAuthClient(fakeSsm(ALL_SECRETS, { fail: boom })), /AccessDenied/);
  await assert.rejects(() => saveCheckpoint('x', fakeSsm(ALL_SECRETS, { fail: boom })), /AccessDenied/);
});

test('the default client is built lazily and reused across calls', async () => {
  const { defaultClient } = await import('../src/ssm.mjs');
  const first = defaultClient();
  assert.equal(typeof first.send, 'function');
  assert.equal(defaultClient(), first, 'a new SSM client per call would leak sockets');
});

test('every export falls back to the shared client when none is passed', async () => {
  const { defaultClient } = await import('../src/ssm.mjs');
  const client = defaultClient();
  const original = client.send;
  const seen = [];
  // Stub only the transport, so the real default-argument path is exercised.
  client.send = (command) => {
    seen.push(command);
    return Promise.resolve({
      Parameters: (command.input.Names ?? []).map((Name) => ({ Name, Value: 'v' })),
    });
  };
  try {
    await loadConfig();
    await loadOAuthClient();
    await saveCheckpoint('2026-07-26T00:00:00.000Z');
    assert.equal(seen.length, 3, 'each export should have used the shared client');
  } finally {
    client.send = original;
  }
});
