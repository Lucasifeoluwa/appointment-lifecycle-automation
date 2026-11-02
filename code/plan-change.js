// Validates a reschedule or cancel request against the stored appointment
// and returns exactly what to change.
//
// Pure function: unit tested in test/, injected verbatim into the
// "Plan Change" Code node by scripts/build-workflows.js.

const MIN_LEAD_MINUTES = 15;
const OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/;

function planChange(request, appointment, now) {
  const r = request || {};
  const action = typeof r.action === 'string' ? r.action.trim().toLowerCase() : '';

  if (!appointment) return { ok: false, httpStatus: 404, error: 'appointment not found' };
  if (action !== 'cancel' && action !== 'reschedule') {
    return { ok: false, httpStatus: 400, error: 'action must be "cancel" or "reschedule"' };
  }
  if (appointment.status === 'Cancelled') {
    return { ok: false, httpStatus: 409, error: 'appointment is already cancelled' };
  }
  if (new Date(appointment.start).getTime() <= now.getTime()) {
    return { ok: false, httpStatus: 409, error: 'appointment has already started or passed' };
  }

  if (action === 'cancel') {
    return {
      ok: true,
      action,
      update: { Status: 'Cancelled', 'Last Change': `Cancelled ${now.toISOString()}` },
    };
  }

  const raw = typeof r.newStart === 'string' ? r.newStart.trim() : '';
  if (!raw || !OFFSET_RE.test(raw)) {
    return { ok: false, httpStatus: 400, error: 'newStart is required and must include a UTC offset' };
  }
  const newStart = new Date(raw);
  if (isNaN(newStart.getTime())) return { ok: false, httpStatus: 400, error: 'newStart is not a valid date' };
  if (newStart.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60000) {
    return { ok: false, httpStatus: 400, error: `newStart must be at least ${MIN_LEAD_MINUTES} minutes in the future` };
  }
  if (newStart.getTime() === new Date(appointment.start).getTime()) {
    return { ok: false, httpStatus: 409, error: 'newStart is the same as the current start' };
  }

  const durationMs = new Date(appointment.end).getTime() - new Date(appointment.start).getTime();
  const newEnd = new Date(newStart.getTime() + durationMs);

  return {
    ok: true,
    action,
    newStartUtc: newStart.toISOString(),
    newEndUtc: newEnd.toISOString(),
    update: {
      Start: newStart.toISOString(),
      End: newEnd.toISOString(),
      Status: 'Confirmed',
      // New time, new reminder cycle.
      'Reminder 24h Sent': false,
      'Reminder 1h Sent': false,
      'Last Change': `Rescheduled ${now.toISOString()} (was ${new Date(appointment.start).toISOString()})`,
    },
  };
}

/**
 * Decide what a Google Calendar change means for the Airtable record.
 * Returns null when Airtable already matches. This is what stops a sync loop:
 * when this system moves an event, the calendar trigger fires, finds Airtable
 * already up to date, and does nothing.
 */
function planCalendarSync(event, appointment) {
  if (!appointment) return null;
  if (event.cancelled) {
    if (appointment.status === 'Cancelled') return null;
    return { Status: 'Cancelled', 'Last Change': 'Cancelled in Google Calendar' };
  }
  const start = new Date(event.start).toISOString();
  const end = new Date(event.end).toISOString();
  const sameStart = new Date(appointment.start).toISOString() === start;
  const sameEnd = new Date(appointment.end).toISOString() === end;
  if (sameStart && sameEnd) return null;
  const update = { Start: start, End: end, 'Last Change': 'Moved in Google Calendar' };
  if (!sameStart) {
    update['Reminder 24h Sent'] = false;
    update['Reminder 1h Sent'] = false;
  }
  return update;
}

module.exports = { planChange, planCalendarSync };
