#!/usr/bin/env node
// Authorises one Gmail mailbox and stores its refresh token in SSM.
//
//   npm run add-account personal
//   npm run add-account work
//
// The name is yours to choose; it just has to match an entry in ACCOUNTS in
// .env. Runs the OAuth loopback flow on localhost, then writes the token
// straight to /gmail-digest/accounts/<name>/refresh-token as a SecureString.
// The token is never printed and never touches disk.
//
// Requires a "Desktop app" OAuth client whose consent screen is published
// ("In production") — in "Testing" status Google expires refresh tokens after
// 7 days and the digest silently dies a week later.
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { OAuth2Client } from 'google-auth-library';
import { gmail } from '@googleapis/gmail';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';

import { loadEnv, ssmPath, accountList } from './lib/env.mjs';

loadEnv();

// Imported only after .env is loaded, so SSM_PREFIX from .env is in place
// before ssm.mjs runs, however that module chooses to read it. A static import
// would run first.
const { loadOAuthClient } = await import('../src/ssm.mjs');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

// --- which account -----------------------------------------------------------

const configured = accountList();
const account = process.argv[2] ?? configured[0];

if (!/^[a-z0-9][a-z0-9-]*$/i.test(account)) {
  console.error(`\n❌ "${account}" is not a usable account name.`);
  console.error('   Use letters, digits, and hyphens: personal, work, side-project.\n');
  process.exit(1);
}

const region = process.env.AWS_REGION;
if (!region) {
  console.error('AWS_REGION is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const tokenPath = ssmPath(`accounts/${account}/refresh-token`);

// --- oauth client credentials ------------------------------------------------

// A malformed client id yields Google's opaque "Error 401: invalid_client —
// The OAuth client was not found", so validate before opening a browser.
const looksValid = (id) => typeof id === 'string' && /\.apps\.googleusercontent\.com$/.test(id);

let clientId = process.env.GOOGLE_CLIENT_ID;
let clientSecret = process.env.GOOGLE_CLIENT_SECRET;

// A stale `export GOOGLE_CLIENT_ID=xxx` lingers for the life of a shell, so an
// obviously-bogus env value is ignored in favour of SSM rather than failing.
if (clientId && !looksValid(clientId)) {
  console.warn(`Ignoring GOOGLE_CLIENT_ID="${clientId}" — not a Google client id. Falling back to SSM.`);
  console.warn('(Run `unset GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET` to silence this.)');
  clientId = undefined;
  clientSecret = undefined;
}

if (!clientId || !clientSecret) {
  try {
    console.log(`Reading OAuth client credentials from SSM (${ssmPath('google-client-*')})…`);
    ({ clientId, clientSecret } = await loadOAuthClient());
  } catch (err) {
    console.error(`Could not read credentials from SSM: ${err.message}`);
    console.error('Store them first with: npm run setup');
    process.exit(1);
  }
}

if (!looksValid(clientId)) {
  console.error(`\n❌ That doesn't look like a Google OAuth client ID: "${clientId}"`);
  console.error('   It should end in ".apps.googleusercontent.com".');
  console.error('   Google Cloud Console → APIs & Services → Credentials → your Desktop client.\n');
  process.exit(1);
}

console.log(`\nAuthorising account "${account}" (client …${clientId.slice(-32)}).`);
console.log('Sign in as the Google account whose mail you want this entry to scan.\n');

// --- consent -----------------------------------------------------------------

const server = http.createServer();
await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', resolve);
});
const redirectUri = `http://127.0.0.1:${server.address().port}`;

const expectedState = crypto.randomBytes(16).toString('hex');
const client = new OAuth2Client(clientId, clientSecret, redirectUri);
// PKCE (RFC 8252 §8.1): a Desktop client's secret ships with the app, so it
// proves nothing. The verifier stays in this process, which means a code
// intercepted on the way back is useless to anyone else.
const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
const authUrl = client.generateAuthUrl({
  access_type: 'offline', // required to receive a refresh token
  prompt: 'consent select_account', // force re-consent, and let you pick the mailbox
  scope: SCOPES,
  state: expectedState, // ties the callback to this run (RFC 8252 §8.9)
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
});

// Best effort only: the URL is printed below, so a machine with no opener (a
// headless Linux box without xdg-open, say) must not crash the flow.
function openBrowser(url) {
  const [command, args, options] = {
    darwin: ['open', [url]],
    // `start` is a cmd builtin. The quoted URL keeps cmd from splitting it at
    // every &, and verbatim arguments stop Node from re-escaping those quotes.
    win32: ['cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true }],
  }[process.platform] ?? ['xdg-open', [url]];
  const child = spawn(command, args, { stdio: 'ignore', detached: true, ...options });
  child.on('error', () => {});
  child.unref();
}

console.log('Opening your browser for Google consent…');
console.log('(You may see an "unverified app" warning — Advanced → continue is fine for personal use.)');
console.log(`\nIf the browser does not open, visit:\n${authUrl}\n`);
openBrowser(authUrl);

const code = await new Promise((resolve, reject) => {
  server.on('request', (req, res) => {
    const url = new URL(req.url, redirectUri);
    const authCode = url.searchParams.get('code');
    const rawError = url.searchParams.get('error');
    if (!authCode && !rawError) {
      // Ignore favicon and other stray requests.
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      // Not the callback for the flow we started — ignore it.
      res.writeHead(403).end('State mismatch — ignoring.');
      return;
    }
    // Only echo Google's defined error codes, never arbitrary input.
    const safeError = rawError && /^[\w.-]{1,64}$/.test(rawError) ? rawError : 'unknown_error';
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      authCode ? '<h3>Success — return to the terminal.</h3>' : `<h3>OAuth error: ${safeError}</h3>`
    );
    if (authCode) resolve(authCode);
    else reject(new Error(`OAuth error: ${safeError}`));
  });
});
server.close();

const { tokens } = await client.getToken({ code, codeVerifier });
if (!tokens.refresh_token) {
  console.error(
    '\n❌ No refresh token in the response.' +
      '\n   Revoke access at https://myaccount.google.com/permissions and re-run.\n'
  );
  process.exit(1);
}

// Google's consent screen has a separate checkbox per permission, and an
// unchecked box yields a token that reads mail fine but fails at send time
// with "403 insufficient authentication scopes". Catch it here instead.
const granted = (tokens.scope ?? '').split(' ').filter(Boolean);
const missing = SCOPES.filter((s) => !granted.includes(s));
if (missing.length > 0) {
  console.error('\n❌ Google did not grant every required permission.\n');
  console.error('   Granted:');
  for (const s of granted) console.error(`     ✓ ${s}`);
  console.error('   Missing:');
  for (const s of missing) console.error(`     ✗ ${s}`);
  console.error(
    '\n   The digest needs BOTH: readonly to scan your mail, send to deliver the digest.' +
      '\n   Re-run and make sure EVERY permission checkbox is ticked on the consent' +
      '\n   screen ("Select all" is easiest). This token was not stored.\n'
  );
  process.exit(1);
}

// Which mailbox you actually consented as. Picking the wrong Google account is
// easy and otherwise stays invisible until a digest arrives full of the wrong mail.
client.setCredentials(tokens);
const profile = await gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
const address = profile.data.emailAddress;

// --- store -------------------------------------------------------------------

await new SSMClient({ region }).send(
  new PutParameterCommand({
    Name: tokenPath,
    Value: tokens.refresh_token,
    Type: 'SecureString',
    Overwrite: true,
  })
);

console.log(`\n✓ Authorised ${address} as "${account}" (both scopes granted).`);
console.log(`  Token stored at ${tokenPath} in ${region}.`);

if (!configured.includes(account)) {
  const updated = [...configured, account].join(',');
  console.log(`
⚠  "${account}" is not in ACCOUNTS yet, so the digest will not scan it.
   Set this in .env, then redeploy:

     ACCOUNTS=${updated}
`);
}

console.log(`Next:
  npm run doctor                  re-check every connection
  DRY_RUN=true npm run preview    see what a digest would look like
`);
