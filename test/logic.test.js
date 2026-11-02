'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateBooking } = require('../code/validate-booking');
const { remindersDue, formatLocal } = require('../code/reminders-due');
const { planChange, planCalendarSync } = require('../code/plan-change');

const NOW = new Date('2026-11-02T09:00:00Z'); // 10:00 in Lagos
const H = 3600000;
const at = (ms) => new Date(NOW.getTime() + ms).toISOString();

// ---------- validateBooking ----------

const good = {
  name: ' Ada Okafor ',
  email: 'Ada@Example.com',
  phone: '+234 801 234 5678',
  service: 'Strategy call',
  start: '2026-11-05T14:00:00+01:00',
  durationMins: 45,
  timezone: 'Africa/Lagos',
};

test('booking: normalises a valid request to UTC', () => {
  const r = validateBooking(good, NOW);
  assert.equal(r.ok, true);
  assert.equal(r.booking.startUtc, '2026-11-05T13:00:00.000Z');
  assert.equal(r.booking.endUtc, '2026-11-05T13:45:00.000Z');
  assert.equal(r.booking.email, 'ada@example.com');
  assert.equal(r.booking.name, 'Ada Okafor');
  assert.equal(r.booking.phone, '+2348012345678');
  assert.match(r.booking.appointmentId, /^APT-[0-9A-Z]+-[0-9A-Z]{4}$/);
});

test('booking: rejects a start time with no UTC offset', () => {
  const r = validateBooking({ ...good, start: '2026-11-05T14:00:00' }, NOW);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /UTC offset/);
});

test('booking: rejects past and too-soon starts', () => {
  assert.equal(validateBooking({ ...good, start: '2026-11-01T10:00:00Z' }, NOW).ok, false);
  assert.equal(validateBooking({ ...good, start: at(10 * 60000).replace('.000', '') }, NOW).ok, false);
  assert.equal(validateBooking({ ...good, start: at(20 * 60000).replace('.000', '') }, NOW).ok, true);
});

test('booking: collects every error, not just the first', () => {
  const r = validateBooking({ email: 'nope', phone: '0801', durationMins: 5, timezone: 'Mars/Base' }, NOW);
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 6);
});

test('booking: defaults duration to 30 minutes and service to Consultation', () => {
  const { durationMins, service, ...rest } = good;
  const r = validateBooking(rest, NOW);
  assert.equal(r.booking.durationMins, 30);
  assert.equal(r.booking.service, 'Consultation');
});

// ---------- remindersDue ----------

const appt = (o) => ({
  appointmentId: 'APT-1',
  status: 'Confirmed',
  start: at(20 * H),
  createdAt: at(-72 * H),
  reminder24hSent: false,
  reminder1hSent: false,
  ...o,
});

test('reminders: 24h reminder when inside 24 hours and not yet sent', () => {
  const [r] = remindersDue([appt()], NOW);
  assert.equal(r.kind, '24h');
  assert.equal(r.setReminder24hSent, true);
});

test('reminders: nothing when more than 24 hours away', () => {
  assert.deepEqual(remindersDue([appt({ start: at(30 * H) })], NOW), []);
});

test('reminders: never sends the same reminder twice', () => {
  assert.deepEqual(remindersDue([appt({ reminder24hSent: true })], NOW), []);
  assert.deepEqual(remindersDue([appt({ start: at(0.5 * H), reminder24hSent: true, reminder1hSent: true })], NOW), []);
});

test('reminders: inside 1 hour sends only the 1h reminder and closes out the 24h one', () => {
  const due = remindersDue([appt({ start: at(0.5 * H) })], NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0].kind, '1h');
  assert.equal(due[0].setReminder24hSent, true);
  assert.equal(due[0].setReminder1hSent, true);
});

test('reminders: booked less than 24h ahead skips the 24h reminder without sending', () => {
  const [r] = remindersDue([appt({ start: at(5 * H), createdAt: at(-1 * H) })], NOW);
  assert.equal(r.kind, 'skip-24h');
  assert.equal(r.setReminder24hSent, true);
});

test('reminders: ignores cancelled, past and malformed appointments', () => {
  const due = remindersDue(
    [appt({ status: 'Cancelled' }), appt({ start: at(-1 * H) }), appt({ start: 'not a date' }), null],
    NOW,
  );
  assert.deepEqual(due, []);
});

test('reminders: local time formatting uses the client timezone', () => {
  assert.match(formatLocal('2026-11-05T13:00:00Z', 'Africa/Lagos'), /2:00\s?pm/i);
  assert.match(formatLocal('2026-11-05T13:00:00Z', 'Europe/London'), /1:00\s?pm/i);
});

// ---------- planChange ----------

const stored = { status: 'Confirmed', start: at(48 * H), end: at(48.75 * H) };

test('change: cancel produces a Cancelled update', () => {
  const p = planChange({ action: 'cancel' }, stored, NOW);
  assert.equal(p.ok, true);
  assert.equal(p.update.Status, 'Cancelled');
});

test('change: reschedule keeps the duration and resets both reminders', () => {
  const p = planChange({ action: 'reschedule', newStart: '2026-11-06T10:00:00+01:00' }, stored, NOW);
  assert.equal(p.ok, true);
  assert.equal(p.newStartUtc, '2026-11-06T09:00:00.000Z');
  assert.equal(p.newEndUtc, '2026-11-06T09:45:00.000Z');
  assert.equal(p.update['Reminder 24h Sent'], false);
  assert.equal(p.update['Reminder 1h Sent'], false);
});

test('change: clear HTTP statuses for each refusal', () => {
  assert.equal(planChange({ action: 'cancel' }, null, NOW).httpStatus, 404);
  assert.equal(planChange({ action: 'delete' }, stored, NOW).httpStatus, 400);
  assert.equal(planChange({ action: 'cancel' }, { ...stored, status: 'Cancelled' }, NOW).httpStatus, 409);
  assert.equal(planChange({ action: 'cancel' }, { ...stored, start: at(-1 * H) }, NOW).httpStatus, 409);
  assert.equal(planChange({ action: 'reschedule', newStart: '2026-11-06T10:00' }, stored, NOW).httpStatus, 400);
  assert.equal(planChange({ action: 'reschedule', newStart: stored.start }, stored, NOW).httpStatus, 409);
});

// ---------- planCalendarSync ----------

test('sync: no-op when Airtable already matches (prevents a sync loop)', () => {
  assert.equal(planCalendarSync({ start: stored.start, end: stored.end }, stored), null);
  assert.equal(planCalendarSync({ cancelled: true }, { ...stored, status: 'Cancelled' }), null);
});

test('sync: an event moved in Google Calendar updates times and resets reminders', () => {
  const u = planCalendarSync({ start: at(50 * H), end: at(50.75 * H) }, stored);
  assert.equal(u.Start, at(50 * H));
  assert.equal(u['Reminder 24h Sent'], false);
});

test('sync: an event deleted in Google Calendar cancels the appointment', () => {
  assert.equal(planCalendarSync({ cancelled: true }, stored).Status, 'Cancelled');
});

test('sync: a length-only change keeps the reminder flags', () => {
  const u = planCalendarSync({ start: stored.start, end: at(49 * H) }, stored);
  assert.equal(u.End, at(49 * H));
  assert.equal('Reminder 24h Sent' in u, false);
});
