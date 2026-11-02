// Decides which reminder, if any, each appointment needs right now.
//
// Pure function: unit tested in test/, injected verbatim into the
// "Decide Reminders" Code node by scripts/build-workflows.js.
//
// The scheduler runs every 15 minutes, so reminders are driven by flags
// rather than exact times: "is this appointment inside the window, and has
// this reminder not been sent yet?" That makes it safe to run late, run twice,
// or miss a run: nothing is sent twice and nothing is skipped silently.
//
// Rules
//   - Only Confirmed appointments that have not started get reminders.
//   - Inside 1 hour of start:  send the 1h reminder (once). If the 24h
//     reminder was never sent, it is marked as skipped, not sent late: two
//     reminders minutes apart is noise.
//   - Inside 24 hours of start: send the 24h reminder (once), unless the
//     appointment was booked less than 24 hours ahead. In that case the
//     booking confirmation just went out and a "see you tomorrow" email
//     minutes later is redundant.

const HOUR = 3600000;

function remindersDue(appointments, now) {
  const t = now.getTime();
  const due = [];

  for (const a of appointments || []) {
    if (!a || a.status !== 'Confirmed' || !a.start) continue;
    const start = new Date(a.start).getTime();
    if (isNaN(start)) continue;
    const msUntil = start - t;
    if (msUntil <= 0) continue;

    const sent24 = Boolean(a.reminder24hSent);
    const sent1h = Boolean(a.reminder1hSent);
    const created = a.createdAt ? new Date(a.createdAt).getTime() : NaN;
    const bookedLate = !isNaN(created) && start - created < 24 * HOUR;

    if (msUntil <= HOUR) {
      if (!sent1h) {
        due.push({ ...a, kind: '1h', setReminder24hSent: true, setReminder1hSent: true });
      }
      continue;
    }

    if (msUntil <= 24 * HOUR && !sent24) {
      if (bookedLate) {
        // Nothing to send, but record the decision so this is not re-evaluated every run.
        due.push({ ...a, kind: 'skip-24h', setReminder24hSent: true, setReminder1hSent: sent1h });
      } else {
        due.push({ ...a, kind: '24h', setReminder24hSent: true, setReminder1hSent: sent1h });
      }
    }
  }

  return due;
}

/** Human-readable local time for messages, in the client's own timezone. */
function formatLocal(iso, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Africa/Lagos',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  }).format(new Date(iso));
}

module.exports = { remindersDue, formatLocal };
