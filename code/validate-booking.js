// Validates and normalises a booking request.
//
// Pure function, no dependencies: unit tested in test/, and injected verbatim
// into the "Validate Booking" Code node by scripts/build-workflows.js.
//
// Times: the request must carry an explicit UTC offset ("2026-11-05T14:00:00+01:00"
// or "...Z"). A bare "2026-11-05T14:00" is rejected, because the server would
// otherwise guess the timezone and the client could arrive an hour off.
// Everything is stored and compared in UTC; the client's IANA timezone is kept
// only so messages can show their local time.

const MIN_LEAD_MINUTES = 15;
const DEFAULT_DURATION = 30;
const MIN_DURATION = 15;
const MAX_DURATION = 240;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const OFFSET_RE = /(Z|[+-]\d{2}:\d{2})$/;

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

function newAppointmentId(now, rand) {
  const r = Math.floor((rand === undefined ? Math.random() : rand) * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `APT-${now.getTime().toString(36).toUpperCase()}-${r.toUpperCase()}`;
}

function validateBooking(body, now) {
  const b = body || {};
  const errors = [];
  const str = (v) => (typeof v === 'string' ? v.trim() : '');

  const name = str(b.name);
  const email = str(b.email).toLowerCase();
  const phone = str(b.phone).replace(/[\s-]/g, '');
  const service = str(b.service) || 'Consultation';
  const timezone = str(b.timezone) || 'Africa/Lagos';
  const startRaw = str(b.start);
  const duration = b.durationMins === undefined ? DEFAULT_DURATION : Number(b.durationMins);

  if (!name) errors.push('name is required');
  if (!EMAIL_RE.test(email)) errors.push('email is missing or invalid');
  if (phone && !E164_RE.test(phone)) errors.push('phone must be in international format, e.g. +2348012345678');
  if (!isValidTimeZone(timezone)) errors.push(`timezone "${timezone}" is not a valid IANA timezone`);

  let start = null;
  if (!startRaw) {
    errors.push('start is required');
  } else if (!OFFSET_RE.test(startRaw)) {
    errors.push('start must include a UTC offset, e.g. 2026-11-05T14:00:00+01:00');
  } else {
    start = new Date(startRaw);
    if (isNaN(start.getTime())) {
      errors.push('start is not a valid date');
      start = null;
    } else if (start.getTime() < now.getTime() + MIN_LEAD_MINUTES * 60000) {
      errors.push(`start must be at least ${MIN_LEAD_MINUTES} minutes in the future`);
    }
  }

  if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) {
    errors.push(`durationMins must be a whole number between ${MIN_DURATION} and ${MAX_DURATION}`);
  }

  if (errors.length) return { ok: false, errors };

  const end = new Date(start.getTime() + duration * 60000);
  return {
    ok: true,
    booking: {
      appointmentId: newAppointmentId(now),
      name,
      email,
      phone: phone || null,
      service,
      timezone,
      durationMins: duration,
      startUtc: start.toISOString(),
      endUtc: end.toISOString(),
      createdAt: now.toISOString(),
    },
  };
}

module.exports = { validateBooking, newAppointmentId };
