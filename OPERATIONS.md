# Operations

Running, fixing, and removing the digest once it's set up. For first-time setup see the [README](README.md#setup). For how it works inside, see [ARCHITECTURE.md](ARCHITECTURE.md).

The commands below use `us-east-1` (the region in `.env.example`) and the defaults `FUNCTION_NAME=gmail-digest` and `SSM_PREFIX=/gmail-digest`. If your `.env` says otherwise, substitute your values. If you use a named AWS profile, export `AWS_PROFILE` before running the `aws` commands: the `npm run` scripts read `.env`, but the AWS CLI doesn't.

Two terms you'll see throughout: the **checkpoint** is a timestamp in SSM (`/gmail-digest/checkpoint`) marking where the last run stopped, and each run's **window** is the mail that arrived between the checkpoint and the run's scheduled time.

## Where everything lives

Everything runs in your own AWS account, in the region from `AWS_REGION`:

| resource | name | created by |
|---|---|---|
| Lambda function (Node 22, arm64, 512 MB, 600 s timeout) | `gmail-digest` | `npm run bootstrap`, updated by `npm run deploy` |
| EventBridge Scheduler schedule (default group) | `gmail-digest` | `npm run bootstrap` |
| IAM role the Lambda runs as | `gmail-digest-lambda` | `npm run bootstrap` |
| IAM role the schedule uses to invoke the Lambda | `gmail-digest-scheduler` | `npm run bootstrap` |
| CloudWatch log group | `/aws/lambda/gmail-digest` | `npm run bootstrap` |
| SSM parameters (keys, tokens, checkpoint) | `/gmail-digest/*` | `npm run setup` (keys), `npm run add-account` (tokens), every real run, including a local `DRY_RUN=false` preview (checkpoint) |

IAM roles are global, not regional. What bootstrap grants each role is described in [ARCHITECTURE.md](ARCHITECTURE.md#aws-resources-and-iam).

On your machine, `.env` holds your settings (no secrets) and `config/profile.mjs` holds your profile, which deploy bundles into the Lambda. Both are gitignored, and the pre-commit hook that `npm install` turns on refuses to commit them (or the `config/profile.mjs.bak` that `npm run setup:profile` leaves behind). For what reaches Anthropic and what the logs can contain, see [the privacy model](ARCHITECTURE.md#privacy-model).

## Start with `npm run doctor`

Whenever something looks wrong, run this first:

```bash
npm run doctor
```

It checks, in order: your `.env`, your profile, your AWS credentials (and prints which account you're in), the keys and tokens in SSM, whether the Lambda exists, each mailbox's Gmail token (can it refresh, does it have both scopes, which address it belongs to), and your Anthropic key and model. Each problem prints as `FAIL` with how to fix it, usually the exact command. `warn` lines are informational (a Lambda that doesn't exist yet is only a warning).

Blind spots: doctor checks your local `.env` and `config/profile.mjs`, not what's deployed, and it doesn't look at the schedule at all. If you edited either file and never ran `npm run deploy`, doctor can pass while the Lambda still runs the old version. To see the deployed settings:

```bash
aws lambda get-function-configuration --function-name gmail-digest --region us-east-1 \
  --query Environment.Variables
```

For the schedule, use the `get-schedule` command under [Changing run times](#changing-run-times).

## Troubleshooting

Every run that finishes logs `Run finished: status=<status>`. A run that fails logs an error instead, and no `Run finished` line. Errors look like `Error (status 400, account work): <message>`. The error name and status vary (`n/a` when there's no status), and the `account` part appears only when one mailbox caused it, so search for the status or a phrase from the message. For the two common token problems the message ends with the exact `npm run add-account <name>` to run.

### Statuses in the logs

| what you see | what it means | what to do |
|---|---|---|
| `status=empty` or `status=nothing-important`, no digest | Normal. Nothing new arrived, or nothing cleared `MIN_IMPORTANCE`. | Nothing. Lower `MIN_IMPORTANCE` if you want more in the digest. |
| `status=skipped` | Normal. A retry, or a run whose window an earlier run already covered. | Nothing. |
| `status=sent` but no digest in your inbox | It went to the deployed `DIGEST_RECIPIENT`, from the mailbox whose address matches it (or else the first one in `ACCOUNTS`). | Check spam and that mailbox's Sent folder. Check the deployed `DIGEST_RECIPIENT` with the `get-function-configuration` command above. |
| `status=sent-checkpoint-stale` | The digest went out, but saving the checkpoint failed, so the next digest repeats these emails. | Nothing, if it's a one-off. If it repeats, `npm run bootstrap` to re-apply the role's permissions. |
| `status=dry-run` on scheduled runs | `DRY_RUN=true` is deployed. Nothing is sent and the checkpoint never moves. Quiet runs still log `status=empty` or `status=nothing-important`, so check the deployed `DRY_RUN` with the `get-function-configuration` command above. | Make sure `.env` doesn't set `DRY_RUN`, then `npm run deploy` (deploy turns it off unless it's set). Don't put `DRY_RUN=false` in `.env`: plain `npm run preview` would then send for real. |

### Errors from a run

| what you see | what it means | what to do |
|---|---|---|
| Error containing `invalid_grant` | Google revoked that mailbox's refresh token. A Google password change does this. So does authorising a mailbox while the app's publishing status was **Testing**, because Google expires those tokens after 7 days. | In Google Cloud, open Google Auth Platform, then **Audience**, and make sure the publishing status is **In production**. Then `npm run add-account <name>`. |
| Error containing `insufficient authentication scopes` | The token can read mail but not send. A permission checkbox was left unticked at consent. Dry runs never send, so this hides until the first real digest. | `npm run add-account <name>` and tick every checkbox. |
| A token keeps dying after you've re-authorised many times | Google keeps at most 100 refresh tokens per Google account per OAuth client and quietly invalidates the oldest. | Authorise each mailbox once and leave it alone. |
| `Missing required SSM parameters: <paths>` | A key was never stored, or a mailbox in the deployed `ACCOUNTS` has no token. The whole run fails. | For `google-client-*` or `anthropic-api-key`: `npm run setup`. For `accounts/<name>/refresh-token`: `npm run add-account <name>`. |
| `AccessDeniedException` reading SSM | The Lambda's role only covers the `SSM_PREFIX` it was bootstrapped with. You changed `SSM_PREFIX` without re-running bootstrap. | `npm run bootstrap`, then `npm run deploy`. |
| `(status 401)` with `authentication_error` | The stored Anthropic key is wrong or revoked. | `npm run setup -- --force` (see [Replacing a key](#replacing-a-key)). |
| `(status 404)` with `not_found_error` naming the model | `MODEL` names a model that doesn't exist. | Fix `MODEL` in `.env` and `npm run deploy`. `npm run doctor` checks it. |
| `(status 400)` mentioning `temperature` | Your model doesn't accept `TEMPERATURE`. | Delete `TEMPERATURE` from `.env` and `npm run deploy`. |
| `(status 400)` mentioning your credit balance | The Anthropic account is out of credit. | Add credit in the Anthropic console. |
| `(status 429)` or `(status 5xx)` from Anthropic (`rate_limit_error`, `overloaded_error`, `api_error`), or `Request timed out.` | Rate limit, an outage, or no answer within 2 minutes. The SDK already retried 3 times, and Lambda retries the whole run, which re-classifies and costs Claude usage again. | Usually nothing. The checkpoint didn't move, so no mail is lost. |
| `Task timed out after 600.00 seconds` | The run took longer than the Lambda allows, usually a very large batch or a slow API. The checkpoint didn't move, and Lambda retries the run. | If it keeps happening, lower `MAX_EMAILS` and `npm run deploy`. Mail over the cap is skipped for good (the digest says how much), so check that mailbox directly after the next run. |
| `RangeError` with `Invalid time zone specified` | `TIMEZONE` isn't a valid IANA name, like `America/New_York`. | Fix it in `.env`, then `npm run deploy` and `npm run bootstrap`. |
| `Classifier chunk incomplete: stop_reason=..., parsed X/Y` | Claude's reply for a batch of emails was cut off or unparseable. The affected emails are treated as medium, with their subject as the summary, so they appear unless `MIN_IMPORTANCE=high`. | Nothing, if it's rare. |
| `Unparseable checkpoint: ...` | The checkpoint parameter holds something that isn't a timestamp (usually hand-edited). | Delete it: `aws ssm delete-parameter --name /gmail-digest/checkpoint --region us-east-1`. The next run looks back 18 hours. |
| `Ignoring invalid MAX_EMAILS=...` or `MIN_IMPORTANCE=...` | The deployed value isn't one the code accepts, so it fell back to the default. | Fix it in `.env` and `npm run deploy`. |

`Ignoring invalid LOOKBACK_HOURS=...` only shows up in a local preview, and means that run used the checkpoint. Fix the value on your preview command line.

### Missing mail, duplicates and links

| what you see | what it means | what to do |
|---|---|---|
| No `Run finished` line and no error at the usual time | Give it 10 minutes first: a run can take that long. If there's still nothing, the schedule didn't fire: it's paused, or on a different time or timezone than you think. | Check it with the `get-schedule` command under [Changing run times](#changing-run-times), and re-enable it there if it's paused. |
| An email you expected isn't in the digest | Usually one of: you archived it before the run (`SCAN_SCOPE=inbox` only sees mail still in the inbox), its sender is in `MUTED_SENDERS`, you'd already replied in that thread, it was rated below `MIN_IMPORTANCE`, or you sent it yourself from that mailbox (mail from the mailbox's own address is always skipped, so test with mail from another account). | Use `SCAN_SCOPE=arrived` if you triage during the day, adjust your profile, or lower `MIN_IMPORTANCE`. Then `npm run deploy`. |
| One mailbox's mail is missing from the digest | That mailbox isn't in the **deployed** `ACCOUNTS`. | Add it to `ACCOUNTS` in `.env`, then `npm run deploy`. |
| The digest says emails "arrived beyond the per-mailbox cap" | More than `MAX_EMAILS` arrived in one mailbox in one window. The extras are skipped for good, not carried over. | Check that mailbox directly. Raise `MAX_EMAILS` (up to 500 per mailbox, the most a run lists) if it happens often. |
| The same digest arrives twice | Usually Gmail accepted the send but the response was lost, so it was sent again. Gmail's send API has no dedupe. The other paths are in [duplicate sends](ARCHITECTURE.md#failures-retries-and-duplicate-sends). | Nothing. It's rare, and the alternative is sometimes losing a digest. |
| A digest link opens the inbox instead of the message | On iPhone, expected. On desktop, you're not signed in to that mailbox in this browser. | See [the iPhone section](#why-digest-links-dont-open-the-gmail-iphone-app). |

For what each status means and when the checkpoint moves, see the run outcomes in [ARCHITECTURE.md](ARCHITECTURE.md#run-outcomes).

## Reading logs

```bash
aws logs tail /aws/lambda/gmail-digest --region us-east-1 --since 1d
```

Just the outcome of each run over the last week, failures and timeouts included:

```bash
aws logs tail /aws/lambda/gmail-digest --region us-east-1 --since 7d \
  --filter-pattern '?"Run finished" ?"Invoke Error" ?"Task timed out"'
```

Add `--follow` to watch live. A normal run logs a `Found N new email(s) across M account(s)` line with the window it scanned, then either `Digest sent (...)` or the reason it skipped sending, then `Run finished`. No log line contains a subject, sender or body (see [the privacy model](ARCHITECTURE.md#privacy-model)).

To run the deployed function right now instead of waiting for the schedule:

```bash
aws lambda invoke --function-name gmail-digest --region us-east-1 --cli-read-timeout 0 /dev/stdout
```

This is a real run: unless `DRY_RUN=true` is deployed, it moves the checkpoint to now. It sends a digest if anything new clears `MIN_IMPORTANCE`, or if a mailbox went over `MAX_EMAILS`. It prints the result, like `{"status":"sent",...}`, or `{"errorType":...,"errorMessage":...}` if the run failed (look the message up under [Troubleshooting](#troubleshooting)).

## Adding or repairing a mailbox

Same command either way. The name is yours to pick (letters, digits and hyphens):

```bash
npm run add-account personal
```

It opens your browser for Google consent, then stores the refresh token at `/gmail-digest/accounts/personal/refresh-token` as an encrypted SecureString. The token is never printed or written to disk. If the browser doesn't open, it prints the URL to visit. Run it on the machine whose browser you'll use: Google redirects back to 127.0.0.1, so it won't work over SSH. It reads your Google client ID and secret from SSM, so run `npm run setup` first.

On the consent screen, click through Google's "unverified app" warning (**Advanced**, then continue; see [below](#googles-unverified-app-banner)), then tick **every** permission checkbox. If any scope is missing, nothing is stored and it tells you to retry. On success it prints the address you authorised, so signing in as the wrong Google account is obvious right away.

**Repairing** an existing mailbox needs nothing else. The Lambda reads tokens from SSM on every run, so the next run uses the new one.

**Adding** a mailbox also means adding it to `ACCOUNTS` and deploying. Store the token first, or every run fails with `Missing required SSM parameters` until you do:

```bash
npm run add-account work     # sign in as the other Google account
# then in .env: ACCOUNTS=personal,work
npm run deploy
```

A new mailbox is scanned from the last run onward, not from its history. With more than one mailbox, each email in the digest is tagged with the mailbox it came from, and its link opens that mailbox. The digest is sent from the mailbox whose address matches `DIGEST_RECIPIENT`, or from the first one in `ACCOUNTS` if none match.

**Removing** a mailbox: take it out of `ACCOUNTS`, `npm run deploy`, then delete its token and revoke the app's access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) while signed in as that account:

```bash
aws ssm delete-parameter --name /gmail-digest/accounts/work/refresh-token --region us-east-1
```

## Replacing a key

To replace a stored key (a rotated Anthropic key, say):

```bash
npm run setup -- --force
```

The `--` matters: without it npm eats `--force` and nothing is replaced. With `--force` it asks for all three values again (Anthropic key, Google client ID, Google client secret), so have them to hand. If `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is exported in your shell, setup uses that value instead of asking (it says so), so `unset` any stale ones first. Like tokens, the new values take effect on the next run without a deploy.

If you replace the Google OAuth client itself (a new client ID), every existing refresh token belonged to the old client, so run `npm run add-account <name>` again for each mailbox.

## Changing settings and deploying

Edit `.env`, then:

```bash
npm run deploy
```

Deploy rebuilds the code (validating your profile first), uploads it, and applies your settings. It also picks up edits to `config/profile.mjs`, since the profile is bundled into the code. It prints every resolved setting before it applies them, so check that list. `.env.example` describes each setting.

For each setting, deploy uses the first of these that has a value:

1. a variable set on the command line (`MIN_IMPORTANCE=high npm run deploy`) or exported in your shell
2. `.env`
3. what's currently deployed
4. the built-in default

Three things follow from that. A command-line value only lasts until the next plain deploy, if `.env` also sets it. An exported variable wins over `.env` on every deploy, so `unset` stale ones. And deleting a line from `.env` doesn't reset that setting, because deploy falls back to what's already on the Lambda, so set the value you want instead.

`DRY_RUN` and `TEMPERATURE` work differently: deploy only takes them from the command line or `.env`, so they switch off on the next deploy that doesn't set them.

If deploy fails with `config/profile.mjs: Invalid profile`, the message lists each problem. Fix `config/profile.mjs` (or re-run `npm run setup:profile`) and deploy again. If it says `No Lambda named "gmail-digest"`, the function doesn't exist in this region yet: run `npm run build && npm run zip && npm run bootstrap`, then deploy.

A few settings aren't (only) applied by deploy:

- **`TIMEZONE`** is used in two places: deploy sends it for the digest's timestamps, and bootstrap sets it on the schedule. Run both after changing it.
- **`LOG_RETENTION_DAYS`** is read only by `npm run bootstrap`. Bootstrap re-applies it every time it runs (14 days if unset), so keep it in `.env` rather than on the command line. It must be a value CloudWatch accepts, such as 7, 14, 30, 90 or 365 (the full list is in the AWS docs for `PutRetentionPolicy`). Anything else makes bootstrap fail before it updates the schedule.
- **`AWS_REGION`, `FUNCTION_NAME` or `SSM_PREFIX`** effectively make a new install. See the next section.

### Changing region, function name or SSM prefix

1. For a new region or function name, delete the old schedule and function first, or the old schedule keeps firing. With a new function name it keeps sending its own digests, and with a new region it fails quietly, because bootstrap repoints the shared IAM roles at the new region. Run the `# Schedule and function` commands under [Removing it completely](#removing-it-completely) with the old values. For a new function name, also run its `# IAM roles` commands with the old name.
2. Update `.env`.
3. For a new region or `SSM_PREFIX`, store everything again: `npm run setup`, then `npm run add-account <name>` for each mailbox. For a new function name alone, skip this, since the keys and tokens are still there.
4. Build and push:

   ```bash
   npm run build && npm run zip && npm run bootstrap && npm run deploy
   ```

5. For a new region or `SSM_PREFIX`, the checkpoint starts empty, so the first run looks back 18 hours. See [Previewing and backfilling](#previewing-and-backfilling) to cover more. Once the new install works, delete the old parameters with the `# Every SSM parameter` command, using the old region and prefix.

## Changing run times

By default the digest runs at 10:00 and 16:00 in `TIMEZONE`. To change that, pass an EventBridge Scheduler cron expression to bootstrap:

```bash
CRON='cron(0 7,12,17 * * ? *)' npm run bootstrap
```

That's 07:00, 12:00 and 17:00 every day. The six fields are minute, hour, day of month, month, day of week and year, and one of the two day fields must be `?`.

It updates the existing schedule in place and keeps it enabled or disabled as it was. Later bootstrap runs without `CRON` keep whatever schedule is deployed, so you don't need to remember it. You can also put `CRON` in `.env`.

Each bootstrap run also sets the schedule's timezone from `TIMEZONE` in `.env` (UTC if unset). Scheduler handles daylight saving itself. The digest subject says Morning for runs before 13:00 local and Afternoon from 13:00 on.

To check what the schedule is actually set to:

```bash
aws scheduler get-schedule --name gmail-digest --region us-east-1 \
  --query '{state: State, cron: ScheduleExpression, timezone: ScheduleExpressionTimezone}'
```

Nothing else needs to change. Each run covers everything since the last one, whatever the gap.

To pause the digest, open the EventBridge console in your region, go to Scheduler, then Schedules, select `gmail-digest` and click **Disable**. Enable it again the same way. Bootstrap never changes this. The first run after you resume covers everything since the last run, up to `MAX_EMAILS` per mailbox. Anything beyond that is skipped, and the digest says so.

## Previewing and backfilling

`npm run preview` runs the real handler on your machine against your real mail, and prints the digest instead of sending it. It's dry unless `DRY_RUN` is exactly `false`, on the command line or in `.env`. The commands below spell out `DRY_RUN=true` anyway, so a `DRY_RUN=false` left in `.env` can't make a preview send:

```bash
DRY_RUN=true npm run preview      # print it, send nothing, leave the checkpoint alone
DRY_RUN=false npm run preview     # really send, and move the checkpoint
```

Any `DRY_RUN=false` preview moves the same checkpoint the Lambda uses, even one that finds nothing to send, so the next scheduled run starts from there.

Normally a preview covers the same window the next scheduled run would: everything since the checkpoint. Right after a real run that's often nothing. To look further back, set `LOOKBACK_HOURS`, which ignores the checkpoint for that one run:

```bash
LOOKBACK_HOURS=72 DRY_RUN=true npm run preview
```

`LOOKBACK_HOURS` only affects local previews. Deploy never sends it to the Lambda. Keep it out of `.env` anyway, or every preview ignores the checkpoint.

You rarely need to backfill. A failed run doesn't move the checkpoint, so the next successful run covers the gap on its own. The exception is when the checkpoint parameter itself is gone (you deleted it, or moved to a new AWS account, region or `SSM_PREFIX`). Then the first run only looks back 18 hours. To send a real digest over a wider window:

```bash
LOOKBACK_HOURS=72 DRY_RUN=false npm run preview
```

Be careful with this one. After a real send the checkpoint jumps to now, so pick a value that reaches back past your last digest, or the mail in between is skipped for good. A wide window can also exceed `MAX_EMAILS` per mailbox, and mail beyond the cap is skipped too. Add `MAX_EMAILS=300` to that command if you expect a lot (500 is the most a run lists per mailbox).

## Failure alarm (optional)

Bootstrap doesn't create one. If you want an email when a run fails, add a CloudWatch alarm on the Lambda's `Errors` metric that notifies an SNS topic:

```bash
R=us-east-1; F=gmail-digest
TOPIC=$(aws sns create-topic --name $F-alarms --region $R --query TopicArn --output text)
aws sns subscribe --topic-arn "$TOPIC" --protocol email \
  --notification-endpoint you@example.com --region $R
aws cloudwatch put-metric-alarm --alarm-name $F-errors \
  --namespace AWS/Lambda --metric-name Errors --dimensions Name=FunctionName,Value=$F \
  --statistic Sum --period 3600 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching \
  --alarm-actions "$TOPIC" --region $R
```

AWS emails you a confirmation link. Click it, or the alarm notifies nobody. The alarm only sees runs that fail with an error. `sent-checkpoint-stale` and incomplete classifier chunks are logged, not raised, so they won't trigger it.

## Google's "unverified app" banner

Your OAuth app will show "Google hasn't verified this app" at consent, and Google's console will nudge you to verify it. Skip it for an app only you use: the cost is one extra click (**Advanced**, then continue) each time you authorise, and a 100-user cap. Verification isn't worth it here, since `gmail.readonly` is a restricted scope and verifying it means an annual security assessment.

Don't switch the publishing status on the **Audience** page back to **Testing** to make the banner go away. Testing is what expires refresh tokens after 7 days. That expiry comes from the publishing status, not from being unverified, so keep it **In production**.

## Why digest links don't open the Gmail iPhone app

On iPhone, a digest link opens a browser view instead of the Gmail app, and usually lands on the inbox rather than the message. Google's links aren't set up to hand off to the Gmail iOS app, and no link format fixes it.

One thing that helps: in the Gmail iOS app, go to **Settings → Default apps** and set links to open in **Safari**. Safari stays signed in to Google, so the link can reach the message there. Desktop browsers aren't affected.

## Moving to a new machine or reinstalling

**New machine, same AWS account:** set up AWS credentials (`aws configure`, or your named profile), clone the repo and run `npm install`. Then copy over your `.env`, replace the example `config/profile.mjs` it created with yours, and run `npm run doctor`. Everything in AWS, checkpoint included, is still there.

**Fresh install** (a new AWS account or region, or after removing everything): follow [Setup in the README](README.md#setup). `npm run setup` skips any keys already stored. The checkpoint starts empty, so the first run looks back 18 hours. To cover a longer gap, see [Previewing and backfilling](#previewing-and-backfilling).

`.env` and `config/profile.mjs` aren't in git, so keep a private copy of both if you might need them on another machine.

## Removing it completely

Set `R`, `F` and `P` to your `AWS_REGION`, `FUNCTION_NAME` and `SSM_PREFIX`, then run these in order. The schedule goes first so nothing invokes the Lambda halfway through.

```bash
R=us-east-1; F=gmail-digest; P=/gmail-digest

# Schedule and function
aws scheduler delete-schedule --name $F --region $R
aws lambda delete-function --function-name $F --region $R
aws logs delete-log-group --log-group-name /aws/lambda/$F --region $R

# IAM roles (global): remove their policies, then the roles
aws iam delete-role-policy --role-name $F-lambda --policy-name $F-ssm
aws iam detach-role-policy --role-name $F-lambda \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
aws iam delete-role --role-name $F-lambda
aws iam delete-role-policy --role-name $F-scheduler --policy-name invoke-$F
aws iam delete-role --role-name $F-scheduler

# Every SSM parameter under the prefix: keys, tokens, checkpoint (10 per call)
aws ssm get-parameters-by-path --path $P --recursive --region $R \
  --query 'Parameters[].Name' --output text \
  | xargs -n 10 aws ssm delete-parameters --region $R --names
```

If you created the failure alarm:

```bash
R=us-east-1; F=gmail-digest
ACCT=$(aws sts get-caller-identity --query Account --output text)
aws cloudwatch delete-alarms --alarm-names $F-errors --region $R
aws sns delete-topic --topic-arn arn:aws:sns:$R:$ACCT:$F-alarms --region $R
```

Outside AWS:

- Revoke the app's access for each mailbox at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- Delete the OAuth client (or the whole project) in Google Cloud Console.
- Revoke the API key in the Anthropic console.
- Delete your clone, which holds `.env` and `config/profile.mjs`.
