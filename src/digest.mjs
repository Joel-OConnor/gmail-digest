const TIER_ORDER = ['high', 'medium', 'low'];
const TIER_COLOR = { high: '#c0392b', medium: '#b7791f', low: '#7f8c8d' };
const TIER_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Opens the message on desktop, where Gmail is already loaded and signed in.
// Addressing the mailbox by email rather than /u/0 matters once you scan more
// than one account: /u/0 is whichever account you happened to sign into first,
// so half the links would land on "message not found".
//
// It cannot work in the Gmail iOS app: mail.google.com publishes no valid Apple
// App Site Association file, so iOS never hands the URL to the app (Android
// does — assetlinks.json delegates to com.google.android.gm). See OPERATIONS.md.
export const messageUrl = (id, mailbox) =>
  `https://mail.google.com/mail/u/${encodeURIComponent(mailbox || '0')}/#all/${encodeURIComponent(id)}`;

/**
 * Subject: [Inbox Digest] {Day Mon D} — {Morning|Afternoon} ({N} emails, {H} high)
 * Morning/Afternoon comes from the local hour in the configured timezone.
 */
export function buildSubject({ now, timezone, total, high }) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(now);
  // Every requested part is always present for a valid timezone; an invalid one
  // throws in the DateTimeFormat constructor above, so no fallback is reachable.
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = Number.parseInt(get('hour'), 10);
  const window = hour < 13 ? 'Morning' : 'Afternoon';
  return `[Inbox Digest] ${get('weekday')} ${get('month')} ${get('day')} — ${window} (${total} emails, ${high} high)`;
}

// "Sat Jul 26, 9:14 AM" in the reader's timezone.
export function formatWhen(dateMs, timezone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(dateMs));
}

/**
 * items: [{id, from: {name, email, domain}, subject, dateMs, importance, summary,
 *          details[], from_person, suggested_reply, account?, accountAddress?}]
 *
 * One section, grouped by sender (busiest first, then alphabetical). Each email
 * carries its own tier, timestamp, summary, facts, and — when a real person
 * wrote it — a ready-to-send reply draft. `showAccounts` tags each email with
 * the mailbox it landed in; only worth the noise when there is more than one.
 */
export function buildDigestHtml({
  items,
  timezone = 'UTC',
  overflowCount = 0,
  overflowIsAtLeast = false,
  filteredCount = 0,
  answeredCount = 0,
  showAccounts = false,
}) {
  const bySender = new Map();
  for (const item of items) {
    const key = item.from.email || item.from.name;
    if (!bySender.has(key)) bySender.set(key, { from: item.from, items: [] });
    bySender.get(key).items.push(item);
  }

  const senders = [...bySender.values()].sort(
    (a, b) => b.items.length - a.items.length || a.from.name.localeCompare(b.from.name)
  );

  const sections = senders
    .map(({ from, items: senderItems }) => {
      const ordered = [...senderItems].sort((a, b) => {
        const tierDiff = TIER_ORDER.indexOf(a.importance) - TIER_ORDER.indexOf(b.importance);
        return tierDiff !== 0 ? tierDiff : b.dateMs - a.dateMs;
      });
      const domain = from.domain
        ? ` <span style="color:#7f8c8d;font-weight:normal;">@${escapeHtml(from.domain)}</span>`
        : '';
      const count = `<span style="color:#7f8c8d;font-weight:normal;font-size:13px;"> &middot; ${ordered.length} email${ordered.length === 1 ? '' : 's'}</span>`;

      return `<div style="margin:0 0 26px;">
<div style="font-size:16px;font-weight:bold;color:#2c3e50;border-bottom:2px solid #e1e5e8;padding-bottom:5px;margin-bottom:10px;">${escapeHtml(from.name)}${domain}${count}</div>
${ordered.map((item) => renderEmail(item, timezone, showAccounts)).join('\n')}
</div>`;
    })
    .join('\n');

  const one = overflowCount === 1;
  const overflowNote =
    overflowCount > 0
      ? `<p style="color:#c0392b;font-size:13px;">Note: ${overflowIsAtLeast ? 'at least ' : ''}${overflowCount} additional email${one ? '' : 's'} arrived beyond the per-mailbox cap and ${one ? 'is' : 'are'} not shown. ${one ? 'It' : 'They'} will not reappear in the next digest &mdash; check your inbox.</p>`
      : '';

  // One quiet line accounting for everything left out, so the digest never
  // looks like it silently lost mail.
  const left = [];
  if (filteredCount > 0) left.push(`${filteredCount} low-priority`);
  if (answeredCount > 0) left.push(`${answeredCount} already answered`);
  const leftTotal = filteredCount + answeredCount;
  const filteredNote =
    left.length > 0
      ? `<p style="color:#95a5a6;font-size:12px;margin-top:20px;">${left.join(', ')} email${leftTotal === 1 ? '' : 's'} left out of this digest.</p>`
      : '';

  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#2c3e50;max-width:680px;">
${overflowNote}
${sections}
${filteredNote}
</div>`;
}

function renderEmail(item, timezone, showAccounts) {
  const account =
    showAccounts && item.account
      ? ` &middot; <span style="color:#7f8c8d;">${escapeHtml(item.account)}</span>`
      : '';
  const tier = `<span style="color:${TIER_COLOR[item.importance]};font-weight:bold;font-size:12px;">${TIER_LABEL[item.importance]}</span>`;
  const details =
    item.details?.length > 0
      ? `<ul style="margin:6px 0 0;padding-left:18px;color:#4a5b6a;font-size:13px;">${item.details
          .map((d) => `<li style="margin:2px 0;">${escapeHtml(d)}</li>`)
          .join('')}</ul>`
      : '';

  // Rendered as selectable text rather than a mailto: link — the point is to
  // read it, edit it, and copy it, which works the same on phone and desktop.
  const reply = item.suggested_reply
    ? `<div style="margin:10px 0 0;padding:10px 12px;background:#f4f7f9;border-left:3px solid #1a5276;border-radius:3px;">
<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#1a5276;font-weight:bold;margin-bottom:5px;">Suggested reply</div>
<div style="font-size:13px;color:#2c3e50;white-space:pre-wrap;">${escapeHtml(item.suggested_reply)}</div>
</div>`
    : '';

  return `<div style="margin:0 0 16px;padding-left:2px;">
<div><a href="${escapeHtml(messageUrl(item.id, item.accountAddress))}" style="color:#1a5276;font-weight:bold;text-decoration:none;">${escapeHtml(item.subject)}</a></div>
<div style="font-size:12px;color:#7f8c8d;margin:2px 0 4px;">${tier} &middot; ${escapeHtml(formatWhen(item.dateMs, timezone))}${account}</div>
<div>${escapeHtml(item.summary)}</div>
${details}
${reply}
</div>`;
}
