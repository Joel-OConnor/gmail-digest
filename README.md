# gmail-digest

An AI inbox digest that runs in your own AWS account, on your own API keys.

Twice a day it reads the mail that arrived since its last run, rates each message against a profile **you write in plain English**, drops everything below your threshold, and emails you one digest grouped by sender. For mail a real person sent you, it drafts a reply you can copy, edit and send. Threads you've already replied to are skipped, and if nothing clears the bar, nothing is sent.

It can scan several Gmail mailboxes and send one combined digest to whichever address you choose.

There's no hosted service in the middle. Your mail goes from Google to your Lambda to Anthropic's API, and the digest goes back out through your own Gmail.

## How it works

1. An EventBridge schedule invokes a Lambda function in your AWS account (by default at 10:00 and 16:00 in your timezone).
2. The Lambda reads its secrets and the checkpoint (when the last run ended) from SSM Parameter Store, AWS's encrypted settings store, then fetches the mail that arrived in each mailbox since then. Muted senders and threads you've answered are left out.
3. Claude rates each email high, medium or low against your profile, summarises it, and drafts a reply when a person wrote to you.
4. Everything below `MIN_IMPORTANCE` is dropped. What's left goes out as one email, sent from one of your own mailboxes.
5. The checkpoint moves forward, so the next run starts exactly where this one ended.

[ARCHITECTURE.md](ARCHITECTURE.md) has the full picture.

## What you need

- An AWS account, and the AWS CLI set up on your machine (`aws configure`, or a named profile) with credentials that can create IAM roles, a Lambda function, a schedule, SSM parameters and a log group. An admin user is simplest.
- A Google account for each mailbox you want scanned.
- An [Anthropic API key](https://console.anthropic.com/settings/keys) on an account with some credit.
- Node 22.13 or newer.
- macOS or Linux with the `zip` command. On Windows, use WSL.

## Setup

### 1. Google Cloud (once)

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com) and enable the **Gmail API** (APIs & Services, then Library, then Gmail API).
2. Open **Google Auth Platform** and set it up as **External** (any app name and your own email are fine). Under **Data Access**, add the scopes `gmail.readonly` and `gmail.send`.
3. On the **Audience** page, click **Publish app** so the publishing status reads **In production**. In "Testing", Google expires refresh tokens after 7 days and your digest quietly stops a week later. You don't need Google's verification (see [the unverified app banner](OPERATIONS.md#googles-unverified-app-banner)).
4. Under Credentials, create an **OAuth client ID** of type **Desktop app**. Keep the client ID and secret handy.

### 2. Install and configure

Clone the repo, `cd` into it, and run:

```bash
npm install
cp .env.example .env
```

`npm install` also creates `config/profile.mjs` from the example and turns on the repo's pre-commit hook (more on both below).

Open `.env` and set at least `AWS_REGION`, `DIGEST_RECIPIENT` and `TIMEZONE` (an IANA name like `Europe/London`), plus `AWS_PROFILE` if your AWS credentials are under a named profile. If you scan more than one mailbox, list them in `ACCOUNTS` (for example `ACCOUNTS=personal,work`).

### 3. Store your keys and connect Gmail

```bash
npm run setup                  # asks for your Anthropic key and Google client ID and secret, stores them in SSM
npm run add-account personal   # opens your browser to authorise one mailbox
npm run doctor                 # checks everything and tells you what to fix
```

`npm run setup` reads each key with the terminal echo off and stores it in SSM as an encrypted SecureString. `npm run add-account` runs Google's sign-in in your browser and stores the refresh token the same way. No secret is written to disk.

Run `add-account` once for each name in `ACCOUNTS`, on a machine with a browser (not over SSH), and sign in as that mailbox's Google account. Google will warn that it hasn't verified the app, which is expected for an app you made yourself: click **Advanced**, then continue. Then tick every permission box, since the digest needs both read and send.

`npm run doctor` checks your settings, profile, AWS credentials, stored keys, each Gmail token (including which address it belongs to) and your Claude key. Fix any `FAIL` lines; most print the command that fixes them. Warnings that your profile is still the example and that the Lambda doesn't exist yet are expected until steps 4 and 6.

### 4. Write your profile

```bash
npm run setup:profile
```

This asks five questions and has Claude turn your answers into a profile. Nothing is saved until you've read it and said yes. If a profile already exists, the old one is kept as `config/profile.mjs.bak`.

Or edit `config/profile.mjs` by hand. Don't edit `config/profile.example.mjs`: it's tracked by git, so anything you put there ends up in a commit.

### 5. Preview it

```bash
npm run preview
```

This runs the real code on your machine against your real mail and prints the digest's HTML. Nothing is sent, and the checkpoint (where the last run stopped) isn't touched. To read it in a browser instead:

```bash
mkdir -p previews && npm run --silent preview > previews/digest.html
```

`previews/` is gitignored, since it holds real mail. With no checkpoint yet, a preview looks back 18 hours; `LOOKBACK_HOURS=72 npm run preview` looks further. More in [previewing and backfilling](OPERATIONS.md#previewing-and-backfilling).

### 6. Go live

```bash
npm run build && npm run zip   # bootstrap creates the function from this zip
npm run bootstrap              # IAM roles, Lambda, log retention, schedule
npm run deploy                 # pushes your code and .env settings
```

The build refuses to run if your profile is invalid, so a broken profile can't reach the Lambda. `npm run bootstrap` is safe to re-run.

The first digest arrives at the next scheduled time (10:00 or 16:00 by default) if anything clears your threshold. To confirm runs are working, look for `Run finished: status=...` in the logs. Use your own region, and since the AWS CLI doesn't read `.env`, export `AWS_PROFILE` first if you use one:

```bash
aws logs tail /aws/lambda/gmail-digest --region us-east-1 --since 1d
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm run doctor` | Re-checks every connection. Run this first when something breaks. |
| `npm run preview` | Renders a digest locally from your real mail. Sends nothing unless you add `DRY_RUN=false`. |
| `npm run deploy` | Rebuilds and pushes your code, profile and `.env` settings to the Lambda. |
| `npm run bootstrap` | Creates or updates the AWS resources. Also how you change run times: `CRON='cron(0 7 * * ? *)' npm run bootstrap`. |
| `npm run add-account <name>` | Authorises a mailbox, or repairs one whose token stopped working. For a new mailbox, also add the name to `ACCOUNTS` in `.env` and run `npm run deploy`. |
| `npm run setup -- --force` | Replaces keys that are already stored, such as a rotated Anthropic key. |
| `npm run setup:profile` | Rebuilds your profile from the interview. |

[OPERATIONS.md](OPERATIONS.md) covers [troubleshooting](OPERATIONS.md#troubleshooting), [reading logs](OPERATIONS.md#reading-logs), [previewing and backfilling](OPERATIONS.md#previewing-and-backfilling) and [removing it completely](OPERATIONS.md#removing-it-completely).

## Configuration

Settings live in `.env`; run `npm run deploy` after changing one. Deleting a line doesn't always reset a setting, so set the value you want instead ([how deploy resolves settings](OPERATIONS.md#changing-settings-and-deploying)). [`.env.example`](.env.example) explains every setting. The ones you're most likely to touch:

| Variable | Default | What it does |
|---|---|---|
| `DIGEST_RECIPIENT` | none, required | Where the digest goes. It has no default on purpose: it decides who reads a summary of your mail. |
| `ACCOUNTS` | `personal` | Comma-separated mailboxes to scan. Each one needs `npm run add-account <name>`. With more than one, every email in the digest is tagged with its mailbox. |
| `MIN_IMPORTANCE` | `medium` | Lowest tier that makes the digest. `high` shows only what needs you today; `low` shows everything. |
| `SCAN_SCOPE` | `inbox` | `inbox` sees only mail still in your inbox when the run fires. `arrived` sees everything that arrived, even if you've archived it. Pick `arrived` if you triage on your phone. |
| `MODEL` | `claude-sonnet-4-6` | `claude-haiku-4-5` is roughly 3x cheaper and blunter. |
| `TIMEZONE` | `UTC` | An IANA name like `Europe/London`. Sets the schedule's clock and the digest's timestamps. After changing it, run both `npm run deploy` and `npm run bootstrap`. |
| `CRON` | `cron(0 10,16 * * ? *)` | When the digest runs, in `TIMEZONE` (10:00 and 16:00 daily by default). Read by `npm run bootstrap`; see [changing run times](OPERATIONS.md#changing-run-times). |
| `MAX_EMAILS` | `100` | Safety cap per mailbox per run. Mail beyond it is skipped for good, and the digest tells you how much. |

## Your profile

`config/profile.mjs` is where you tell the classifier what matters. It's gitignored, bundled into the Lambda at build time, and has five exports:

- `ABOUT_YOU`: who you are and what you're dealing with right now, so the classifier can judge what's relevant.
- `RUBRIC`: what counts as high, medium and low. It must mention all three tiers.
- `MUTED_SENDERS`: full email addresses to drop at the Gmail search, so they're never fetched or sent to Claude. Bare domains are rejected, since they'd mute real people too.
- `VOICE`: how everything in the digest is written. Claude treats these rules as hard constraints, so this is where words or punctuation you never want to see go.
- `REPLY_STYLE`: how drafted replies sound, plus the rules that stop them inventing facts about you.

After editing it, check the result with `npm run preview`, then run `npm run deploy`.

## What it costs

Claude is the only real cost. Bodies are truncated to 4,000 characters, so as a rough estimate, around 40 emails a day on Sonnet costs about $0.10 to $0.15 a day. Lambda, SSM, EventBridge Scheduler and CloudWatch are effectively free at that volume.

## Privacy and security

- Your mail is read by your own Lambda and sent to Anthropic's API for classification. Nothing else sees it.
- Google access is limited to `gmail.readonly` and `gmail.send`. The Lambda's IAM role can read only the SSM parameters under your `SSM_PREFIX` and can write only the checkpoint.
- Your Anthropic key, Google client secret and refresh tokens are stored as encrypted SSM SecureStrings and never written to disk.
- CloudWatch logs hold counts, timestamps and error messages, never subjects, senders or bodies. They're kept for 14 days (`LOG_RETENTION_DAYS`).
- `.env` and `config/profile.mjs` are gitignored. The pre-commit hook that `npm install` turns on also blocks them and `previews/`, anything shaped like an API key, client secret, refresh token or AWS account ID, and any tracked file containing your `DIGEST_RECIPIENT`, other protected `.env` values, or text from your profile (`test/no-leaks.test.mjs`).

[ARCHITECTURE.md](ARCHITECTURE.md#privacy-model) lists exactly what reaches Anthropic, Google, SSM and the logs.

## Development

Plain Node ESM, no framework.

```bash
npm test                 # the test suite, offline
npm run test:coverage    # the same, with a 100% coverage gate
npm run lint
```

Tests use `node:test` with no mocking library. Modules take their clients as arguments, so fakes are plain objects and nothing touches the network. `--conditions=test` points the `#profile` import at `test/fixtures/profile.fixture.mjs`, so tests never see your real profile. The one exception is `test/no-leaks.test.mjs`, which reads your `.env` and profile to know what must not leak, and visibly skips those checks when they aren't there. The suite passes on a fresh clone.

The coverage gate (100% lines, branches and functions) covers `src/` and `scripts/lib/render-profile.mjs`. The CLI scripts in `scripts/` aren't unit tested.

CI runs lint, the coverage gate and a build on every push to `main` and every pull request, with no `.env` and only the example profile that `npm ci` creates, the same as a fresh clone.

## License

MIT. See [LICENSE](LICENSE).
