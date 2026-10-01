import { loadConfig, saveCheckpoint } from './ssm.mjs';
import {
  createGmailClient,
  fetchNewEmails,
  sendDigest,
  authenticatedAddress,
} from './gmail.mjs';
import {
  createAnthropicClient,
  classifyEmails,
  filterByImportance,
  IMPORTANCE_WEIGHT,
} from './classify.mjs';
import { buildSubject, buildDigestHtml } from './digest.mjs';

const DEFAULT_LOOKBACK_HOURS = 18;
const DEFAULT_MAX_EMAILS = 100;

// Everything the run reaches outside itself, injected so tests can drive the
// orchestration without AWS, Gmail, or Anthropic. Production uses these.
const defaultDeps = {
  loadConfig,
  saveCheckpoint,
  createGmailClient,
  fetchNewEmails,
  sendDigest,
  authenticatedAddress,
  createAnthropicClient,
  classifyEmails,
};

// Lambda invokes this as (event, context, callback) — keep it 1-arity so no
// runtime argument can ever land in the deps slot. Tests call runDigest.
export const handler = (event) => runDigest(event);

// Privacy rule: log counts, window timestamps, and statuses only, never
// subjects, senders, or bodies. DRY_RUN prints the rendered digest when run
// locally, and only its subject line inside Lambda.
export async function runDigest(event, overrides) {
  try {
    const result = await run(event, { ...defaultDeps, ...overrides });
    // The status is otherwise only a return value, and CloudWatch is where
    // people go looking for it.
    console.log(`Run finished: status=${result.status}`);
    return result;
  } catch (err) {
    throw sanitizeError(err);
  }
}

/**
 * Client errors carry far more than their message in enumerable properties. A
 * Gmail error holds the request it failed on (the rendered digest for a failed
 * send, the refresh token and client secret for a failed token refresh), and
 * an Anthropic error holds the full response. The Lambda runtime would
 * serialize all of it into CloudWatch. Rebuild a bare Error so only the message
 * survives, name the mailbox that failed when we know it, and append the fix
 * for the auth failures that actually recur.
 */
export function sanitizeError(err) {
  const status = err?.status ?? err?.response?.status ?? err?.code ?? 'n/a';
  const message = err?.message ?? String(err);
  const account = err?.account;
  const reauth = `npm run add-account ${account ?? '<name>'}`;
  let hint = '';
  if (/insufficient authentication scopes/i.test(message)) {
    hint =
      ' Fix: the refresh token lacks gmail.send.' +
      ` Run \`${reauth}\` and tick every permission checkbox.`;
  } else if (/invalid_grant/i.test(message)) {
    hint =
      ' Fix: the refresh token was revoked (a Google password change does this).' +
      ` Re-authorise with \`${reauth}\`.`;
  } else if (/invalid_client/i.test(message)) {
    hint =
      ' Fix: the Google OAuth client ID or secret stored in SSM is wrong.' +
      ' Store the right ones with `npm run setup -- --force`.';
  }
  const where = account ? `, account ${account}` : '';
  const clean = new Error(`${err?.name ?? 'Error'} (status ${status}${where}): ${message}${hint}`);
  clean.stack = err?.stack ?? clean.stack;
  return clean;
}

async function run(event, deps) {
  const runStart = new Date();
  const dryRun = process.env.DRY_RUN === 'true';
  const timezone = process.env.TIMEZONE || 'UTC';
  const model = process.env.MODEL || 'claude-sonnet-4-6';
  const maxEmails = resolveMaxEmails(process.env.MAX_EMAILS);
  const minImportance = resolveMinImportance(process.env.MIN_IMPORTANCE);
  const scope = process.env.SCAN_SCOPE === 'arrived' ? 'arrived' : 'inbox';
  const recipient = process.env.DIGEST_RECIPIENT;
  if (!recipient) throw new Error('DIGEST_RECIPIENT env var is required');

  // The schedule passes its exact fire time (the schedule's Input in
  // scripts/bootstrap.mjs). Using it as the window end makes retries
  // idempotent: a retry of an already-digested window sees checkpoint >=
  // windowEnd and exits. Manual/local invocations fall back to "now".
  const scheduledMs = event?.scheduledTime ? Date.parse(event.scheduledTime) : NaN;
  const windowEnd = Number.isNaN(scheduledMs) ? runStart : new Date(scheduledMs);

  const config = await deps.loadConfig();

  // LOOKBACK_HOURS overrides the checkpoint for this run: it is how you preview
  // a digest against a quiet window, and how you backfill after an outage. It
  // can re-show mail an earlier digest already covered, which is why it is not
  // the normal path.
  const lookbackHours = resolveLookbackHours(process.env.LOOKBACK_HOURS);
  const hoursBack = lookbackHours ?? DEFAULT_LOOKBACK_HOURS;
  const useCheckpoint = lookbackHours === null && config.checkpoint;
  const sinceMs = useCheckpoint
    ? Date.parse(config.checkpoint)
    : windowEnd.getTime() - hoursBack * 60 * 60 * 1000;
  if (Number.isNaN(sinceMs)) throw new Error(`Unparseable checkpoint: ${config.checkpoint}`);

  // Idempotency guard: a scheduler retry after a successful run must not double-send.
  if (sinceMs >= windowEnd.getTime()) {
    console.log(
      `Checkpoint (${config.checkpoint}) already covers window end (${windowEnd.toISOString()}); nothing to do. Exiting.`
    );
    return { status: 'skipped' };
  }

  // Each account is fetched with its own client. The cap is per account, so
  // adding a mailbox never silently starves the others.
  const mailboxes = [];
  let emails = [];
  let overflowCount = 0;
  let overflowIsAtLeast = false;
  let answeredCount = 0;

  for (const account of config.accounts) {
    const client = deps.createGmailClient({ ...config, refreshToken: account.refreshToken });
    // Which mailbox this token actually opens. Needed twice: the From header
    // must be an address that can send, and the digest's links must point at
    // the right signed-in account.
    const { address, result } = await inMailbox(account.name, async () => ({
      address: await deps.authenticatedAddress(client),
      result: await deps.fetchNewEmails(client, {
        sinceMs,
        untilMs: windowEnd.getTime(),
        maxEmails,
        scope,
      }),
    }));
    mailboxes.push({ name: account.name, client, address });
    // Message ids are unique only within a mailbox, so every email carries its
    // source and everything downstream keys on account + id.
    emails = emails.concat(
      result.emails.map((e) => ({
        ...e,
        key: `${account.name}:${e.id}`,
        account: account.name,
        accountAddress: address,
      }))
    );
    overflowCount += result.overflowCount;
    overflowIsAtLeast ||= result.overflowIsAtLeast;
    answeredCount += result.answeredCount;
  }

  console.log(
    `Found ${emails.length} new email(s) across ${mailboxes.length} account(s) [scope=${scope}] in (${new Date(sinceMs).toISOString()}, ${windowEnd.toISOString()}]` +
      (answeredCount > 0 ? ` (${answeredCount} already answered, skipped)` : '') +
      (overflowCount > 0
        ? ` (${overflowIsAtLeast ? 'at least ' : ''}${overflowCount} more beyond MAX_EMAILS=${maxEmails})`
        : '')
  );

  // Overflowed mail is never fetched again once the checkpoint moves, so any
  // overflow is worth a digest even when nothing else is: it is the only notice.
  if (emails.length === 0 && overflowCount === 0) {
    console.log('Zero new emails — skipping send.');
    if (!dryRun) await deps.saveCheckpoint(windowEnd.toISOString());
    return { status: 'empty' };
  }

  let items = [];
  if (emails.length > 0) {
    const anthropic = deps.createAnthropicClient(config.anthropicApiKey);
    const classified = await deps.classifyEmails(anthropic, emails, model);
    items = emails.map((email) => ({ ...email, ...classified.get(email.key) }));
  }

  // Only surface emails at/above MIN_IMPORTANCE; the rest are noise.
  const shown = filterByImportance(items, minImportance);
  const filteredCount = items.length - shown.length;

  if (shown.length === 0 && overflowCount === 0) {
    console.log(
      `All ${items.length} new email(s) classified below '${minImportance}' — nothing important, skipping send.`
    );
    if (!dryRun) await deps.saveCheckpoint(windowEnd.toISOString());
    return { status: 'nothing-important', filtered: filteredCount };
  }

  const highCount = shown.filter((i) => i.importance === 'high').length;
  const subject = buildSubject({ now: windowEnd, timezone, total: shown.length, high: highCount });
  const html = buildDigestHtml({
    items: shown,
    timezone,
    overflowCount,
    overflowIsAtLeast,
    filteredCount,
    answeredCount,
    showAccounts: mailboxes.length > 1,
  });

  // `emails` counts everything classified; `shown` is what the digest lists.
  // They differ whenever MIN_IMPORTANCE filtered something out, so report both.
  const outcome = {
    emails: items.length,
    shown: shown.length,
    high: highCount,
    filtered: filteredCount,
    answered: answeredCount,
  };

  if (dryRun) {
    // Locally the rendered digest is the whole point. Inside Lambda the same
    // line would write every subject, summary, and reply draft to CloudWatch,
    // where it outlives the run — so there, print the counts only.
    const inLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
    console.log(
      `DRY RUN — nothing sent, checkpoint not updated.\nSubject: ${subject}\n\n` +
        (inLambda ? '(digest body withheld: DRY_RUN in Lambda would log mail content)' : html)
    );
    return { status: 'dry-run', ...outcome };
  }

  // Send from the mailbox that owns the recipient address when one does, else
  // the first. From must be an address the sending account can actually send
  // as, or the digest fails DMARC and lands in spam.
  // Gmail reports the address lowercased; DIGEST_RECIPIENT is typed by hand.
  const wanted = recipient.trim().toLowerCase();
  const sender =
    mailboxes.find((m) => String(m.address).trim().toLowerCase() === wanted) ?? mailboxes[0];
  await inMailbox(sender.name, () =>
    deps.sendDigest(sender.client, { from: sender.address, to: recipient, subject, html })
  );
  try {
    await deps.saveCheckpoint(windowEnd.toISOString());
  } catch (err) {
    // Throwing here would make Lambda's async retry run everything again and
    // send this digest twice. A stale checkpoint only means the next digest
    // repeats these emails, which is the lesser problem.
    console.error(
      `Digest sent, but saving the checkpoint failed, so the next digest will repeat these emails. ${sanitizeError(err).message}`
    );
    return { status: 'sent-checkpoint-stale', ...outcome };
  }
  console.log(
    `Digest sent (${shown.length} shown of ${items.length} classified, ${highCount} high). Checkpoint -> ${windowEnd.toISOString()}`
  );
  return { status: 'sent', ...outcome };
}

// MIN_IMPORTANCE controls what makes it into the digest: 'medium' (default)
// shows high + medium and drops low-tier noise; 'high' shows only high;
// 'low' shows everything. hasOwn (not `in`) so inherited keys like "toString"
// can't be accepted as a tier — that would filter out every email silently.
export function resolveMinImportance(raw) {
  if (raw == null || raw === '') return 'medium';
  if (!Object.hasOwn(IMPORTANCE_WEIGHT, raw)) {
    console.log(`Ignoring invalid MIN_IMPORTANCE=${JSON.stringify(raw)}; using "medium".`);
    return 'medium';
  }
  return raw;
}

// LOOKBACK_HOURS must be a positive number of hours; anything else is ignored
// so a typo silently widens nothing.
export function resolveLookbackHours(raw) {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseFloat(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.log(`Ignoring invalid LOOKBACK_HOURS=${JSON.stringify(raw)}; using the checkpoint.`);
  return null;
}

// MAX_EMAILS must be a positive integer; anything else falls back to the
// default so a typo can't silently advance the checkpoint past real mail.
// Digits only, because parseInt would read "1,000" as 1 and "10abc" as 10.
export function resolveMaxEmails(raw) {
  const parsed = /^\s*\d+\s*$/.test(raw ?? '') ? Number(raw) : NaN;
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  if (raw != null && raw !== '') {
    console.log(`Ignoring invalid MAX_EMAILS=${JSON.stringify(raw)}; using ${DEFAULT_MAX_EMAILS}.`);
  }
  return DEFAULT_MAX_EMAILS;
}

// Tags a failure with the mailbox it came from, so the logged error says which
// account to re-authorise rather than leaving you to guess.
async function inMailbox(name, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Object) {
      err.account = name;
      throw err;
    }
    throw Object.assign(new Error(String(err)), { account: name });
  }
}
