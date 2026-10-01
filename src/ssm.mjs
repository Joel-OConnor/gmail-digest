import { SSMClient, GetParametersCommand, PutParameterCommand } from '@aws-sdk/client-ssm';

// Configurable so two installs can share one AWS account without seeing each
// other's tokens. Read on every call, not at import: scripts load .env after
// their static imports have run, so an import-time read would miss it.
const prefix = () => (process.env.SSM_PREFIX || '/gmail-digest').replace(/\/$/, '');

/** Mailboxes to scan, from ACCOUNTS. One unnamed account is the default. */
export function accountNames() {
  const names = [
    ...new Set(
      (process.env.ACCOUNTS ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
    ),
  ];
  return names.length > 0 ? names : ['personal'];
}

// Lazily constructed so importing this module never touches AWS, and so tests
// can pass their own client. Every export takes `client` as an optional last
// argument defaulting to the shared one.
let shared;
// Exported so tests can prove the memoisation; constructing an SSMClient makes
// no network call, so this is safe to invoke anywhere.
export function defaultClient() {
  shared ??= new SSMClient({});
  return shared;
}

const sharedSecrets = () => [
  `${prefix()}/google-client-id`,
  `${prefix()}/google-client-secret`,
  `${prefix()}/anthropic-api-key`,
];
const checkpointName = () => `${prefix()}/checkpoint`;
// Where a single-account install stored its token before per-account paths.
const legacyToken = () => `${prefix()}/google-refresh-token`;

export const tokenPath = (account) => `${prefix()}/accounts/${account}/refresh-token`;

// GetParameters rejects a request naming more than 10 parameters.
const MAX_NAMES_PER_CALL = 10;

// Fetches any number of names, in as few calls as the API allows, and returns
// { name: value } for the ones that exist.
async function getParameters(client, names) {
  const batches = [];
  for (let i = 0; i < names.length; i += MAX_NAMES_PER_CALL) {
    batches.push(names.slice(i, i + MAX_NAMES_PER_CALL));
  }
  const responses = await Promise.all(
    batches.map((Names) => client.send(new GetParametersCommand({ Names, WithDecryption: true })))
  );
  return Object.fromEntries(
    responses.flatMap((res) => res.Parameters ?? []).map((p) => [p.Name, p.Value])
  );
}

/**
 * Fetches the shared secrets, the checkpoint, and a refresh token per account.
 * That is one GetParameters call for up to five accounts, and another for every
 * ten names beyond that.
 *
 * Returns { googleClientId, googleClientSecret, anthropicApiKey, checkpoint,
 * accounts: [{ name, refreshToken }] }.
 */
export async function loadConfig(client = defaultClient()) {
  const names = accountNames();
  const secrets = sharedSecrets();
  const byName = await getParameters(client, [
    ...secrets,
    checkpointName(),
    legacyToken(),
    ...names.map(tokenPath),
  ]);

  const missing = secrets.filter((n) => !byName[n]);

  const accounts = names.map((name) => ({
    name,
    // A single-account install that predates per-account paths keeps working.
    refreshToken:
      byName[tokenPath(name)] ?? (names.length === 1 ? byName[legacyToken()] : undefined),
  }));
  for (const account of accounts) {
    if (!account.refreshToken) missing.push(tokenPath(account.name));
  }

  if (missing.length > 0) {
    throw new Error(`Missing required SSM parameters: ${missing.join(', ')}`);
  }

  return {
    googleClientId: byName[secrets[0]],
    googleClientSecret: byName[secrets[1]],
    anthropicApiKey: byName[secrets[2]],
    checkpoint: byName[checkpointName()] ?? null, // ISO timestamp or null on first run
    accounts,
  };
}

// Just the OAuth client credentials — used by scripts/get-refresh-token.mjs so
// re-minting a token doesn't require pasting the client id/secret by hand.
export async function loadOAuthClient(client = defaultClient()) {
  const names = [`${prefix()}/google-client-id`, `${prefix()}/google-client-secret`];
  const byName = await getParameters(client, names);
  const missing = names.filter((n) => !byName[n]);
  if (missing.length > 0) {
    throw new Error(`Missing required SSM parameters: ${missing.join(', ')}`);
  }
  return {
    clientId: byName[names[0]],
    clientSecret: byName[names[1]],
  };
}

export async function saveCheckpoint(isoTimestamp, client = defaultClient()) {
  await client.send(
    new PutParameterCommand({
      Name: checkpointName(),
      Value: isoTimestamp,
      Type: 'String',
      Overwrite: true,
    })
  );
}
