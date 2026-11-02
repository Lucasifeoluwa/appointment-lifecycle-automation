#!/usr/bin/env node
'use strict';

/**
 * Builds the four n8n workflow JSON files in workflows/.
 *
 * The decision logic lives in code/ as plain, unit-tested JavaScript. This
 * script pastes each module's source verbatim into its Code node, followed by
 * a few lines that feed it n8n data. What the tests exercise is exactly what
 * runs in n8n.
 *
 *   node scripts/build-workflows.js
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/** Module source without its module.exports line, plus an n8n wrapper. */
function inline(files, wrapper) {
  const src = files
    .map((f) =>
      fs
        .readFileSync(path.join(root, f), 'utf8')
        .replace(/^module\.exports\s*=.*$/m, '')
        .trim(),
    )
    .join('\n\n');
  return `// ---- logic from ${files.join(', ')} (unit tested in test/) ----\n${src}\n\n// ---- n8n wrapper ----\n${wrapper.trim()}\n`;
}

// ---------- shared node builders ----------

const retry = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };
const airtableCreds = { airtableTokenApi: { id: 'REPLACE_ME', name: 'Airtable account' } };
const gcalCreds = { googleCalendarOAuth2Api: { id: 'REPLACE_ME', name: 'Google Calendar account' } };
const smtpCreds = { smtp: { id: 'REPLACE_ME', name: 'SMTP account' } };
const base = { __rl: true, mode: 'id', value: '={{ $env.AIRTABLE_BASE_ID }}' };
const table = { __rl: true, mode: 'id', value: '={{ $env.AIRTABLE_APPOINTMENTS_TABLE_ID }}' };
const calendar = { __rl: true, mode: 'id', value: '={{ $env.GOOGLE_CALENDAR_ID }}' };

const FIELD_TYPES = {
  'Reminder 24h Sent': 'boolean',
  'Reminder 1h Sent': 'boolean',
  'Duration (mins)': 'number',
};

function columns(fields, matchingColumns = []) {
  return {
    mappingMode: 'defineBelow',
    value: fields,
    matchingColumns,
    schema: Object.keys(fields).map((f) => ({
      id: f,
      displayName: f,
      required: false,
      defaultMatch: false,
      canBeUsedToMatch: true,
      display: true,
      type: FIELD_TYPES[f] || 'string',
      removed: false,
    })),
    attemptToConvertTypes: true,
    convertFieldsToString: false,
  };
}

let seq = 0;
const node = (name, type, typeVersion, position, parameters, extra = {}) => ({
  id: `n${++seq}`,
  name,
  type,
  typeVersion,
  position,
  parameters,
  ...extra,
});

const webhook = (name, p, pos) =>
  node(name, 'n8n-nodes-base.webhook', 2, pos, {
    httpMethod: 'POST',
    path: p,
    responseMode: 'responseNode',
    options: {},
  }, { webhookId: p.replace(/\//g, '-') });

const code = (name, pos, jsCode, mode) =>
  node(name, 'n8n-nodes-base.code', 2, pos, mode ? { mode, jsCode } : { jsCode });

function ifNode(name, pos, leftValue, operator, rightValue) {
  const c = { id: `${name}-c`, leftValue, operator };
  if (rightValue !== undefined) c.rightValue = rightValue;
  return node(name, 'n8n-nodes-base.if', 2.2, pos, {
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
      conditions: [c],
      combinator: 'and',
    },
    options: {},
  });
}
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };
const exists = { type: 'string', operation: 'exists', singleValue: true };

const respond = (name, pos, status, body) =>
  node(name, 'n8n-nodes-base.respondToWebhook', 1.1, pos, {
    respondWith: 'json',
    responseBody: `={{ JSON.stringify(${body}) }}`,
    options: { responseCode: status },
  });

const airtable = (name, pos, operation, params, extra = {}) =>
  node(name, 'n8n-nodes-base.airtable', 2.1, pos, { operation, base, table, ...params }, {
    ...retry,
    credentials: airtableCreds,
    ...extra,
  });

const email = (name, pos, to, subject, html, extra = {}) =>
  node(name, 'n8n-nodes-base.emailSend', 2.1, pos, {
    fromEmail: '={{ $env.FROM_EMAIL }}',
    toEmail: to,
    subject,
    emailFormat: 'html',
    html,
    options: {},
  }, { ...retry, credentials: smtpCreds, ...extra });

const slack = (name, pos, text) =>
  node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
    method: 'POST',
    url: '={{ $env.SLACK_WEBHOOK_URL }}',
    sendBody: true,
    specifyBody: 'json',
    jsonBody: `={{ JSON.stringify({ text: ${text} }) }}`,
    options: {},
  }, { ...retry, onError: 'continueRegularOutput' });

const link = (from, ...targets) => ({ [from]: { main: targets.map((t) => (t ? [{ node: t, type: 'main', index: 0 }] : [])) } });
const wf = (name, nodes, conns) => ({
  name,
  nodes,
  connections: Object.assign({}, ...conns),
  settings: { executionOrder: 'v1' },
  pinData: {},
  active: false,
});

// Safe for an Airtable formula: IDs only ever contain letters, digits, - and _.
const safe = (expr) => `{{ String(${expr} || '').replace(/[^A-Za-z0-9_-]/g, '') }}`;

// =====================================================================
// 1. BOOK
// =====================================================================
seq = 0;
const B = "$('Validate Booking').first().json.booking";
const book = wf(
  'Appointments: Book',
  [
    webhook('Booking Request', 'appointments/book', [0, 300]),
    code('Validate Booking', [220, 300], inline(['code/validate-booking.js'], `
return [{ json: validateBooking($input.first().json.body, new Date()) }];
`)),
    ifNode('Valid?', [440, 300], '={{ $json.ok }}', isTrue),
    respond('Respond 400: Invalid', [660, 480], 400, '{ ok: false, errors: $json.errors }'),
    // Google free/busy: always exactly one item, { available: true|false }.
    // (Listing events would need "always output data" for the empty case, and
    // n8n then sends an empty item down the success path even when the call
    // fails, which would book over a conflict. Free/busy has no empty case.)
    node('Check Availability', 'n8n-nodes-base.googleCalendar', 1.3, [660, 200], {
      resource: 'calendar',
      operation: 'availability',
      calendar,
      timeMin: `={{ ${B}.startUtc }}`,
      timeMax: `={{ ${B}.endUtc }}`,
      options: { outputFormat: 'availability' },
    }, { ...retry, onError: 'continueErrorOutput', credentials: gcalCreds }),
    ifNode('Slot Free?', [880, 200], '={{ $json.available }}', { type: 'boolean', operation: 'true', singleValue: true }),
    respond('Respond 409: Slot Taken', [1100, 380], 409, "{ ok: false, errors: ['That time is already booked. Please pick another slot.'] }"),
    node('Create Calendar Event', 'n8n-nodes-base.googleCalendar', 1.3, [1100, 100], {
      calendar,
      start: `={{ ${B}.startUtc }}`,
      end: `={{ ${B}.endUtc }}`,
      useDefaultReminders: false,
      additionalFields: {
        summary: `={{ ${B}.service }}: {{ ${B}.name }}`,
        description: `=Booked via automation.\nAppointment ID: {{ ${B}.appointmentId }}\nClient: {{ ${B}.name }} <{{ ${B}.email }}>\nPhone: {{ ${B}.phone || 'n/a' }}`,
      },
    }, { ...retry, onError: 'continueErrorOutput', credentials: gcalCreds }),
    airtable('Save Appointment', [1320, 0], 'create', {
      columns: columns({
        'Appointment ID': `={{ ${B}.appointmentId }}`,
        Name: `={{ ${B}.name }}`,
        Email: `={{ ${B}.email }}`,
        Phone: `={{ ${B}.phone }}`,
        Service: `={{ ${B}.service }}`,
        Start: `={{ ${B}.startUtc }}`,
        End: `={{ ${B}.endUtc }}`,
        'Duration (mins)': `={{ ${B}.durationMins }}`,
        Timezone: `={{ ${B}.timezone }}`,
        Status: 'Confirmed',
        'Calendar Event ID': '={{ $json.id }}',
        'Created At': `={{ ${B}.createdAt }}`,
      }),
      options: { typecast: true },
    }, { onError: 'continueErrorOutput' }),
    email('Send Confirmation', [1540, -100], `={{ ${B}.email }}`,
      `=Confirmed: {{ ${B}.service }} on {{ new Date(${B}.startUtc).toLocaleString('en-GB', { timeZone: ${B}.timezone, dateStyle: 'full', timeStyle: 'short' }) }}`,
      `=<p>Hi {{ ${B}.name }},</p>
<p>Your <strong>{{ ${B}.service }}</strong> is confirmed for
<strong>{{ new Date(${B}.startUtc).toLocaleString('en-GB', { timeZone: ${B}.timezone, dateStyle: 'full', timeStyle: 'short' }) }}</strong>
({{ ${B}.timezone }}), {{ ${B}.durationMins }} minutes.</p>
<p>We'll remind you the day before and an hour before.</p>
<p>Need to change it? Reply to this email and quote <strong>{{ ${B}.appointmentId }}</strong>.</p>`,
      { onError: 'continueRegularOutput' }),
    respond('Respond 201: Booked', [1760, -100], 201,
      `{ ok: true, appointmentId: ${B}.appointmentId, start: ${B}.startUtc, end: ${B}.endUtc }`),
    // Compensation: the calendar event exists but the record could not be saved.
    node('Undo Calendar Event', 'n8n-nodes-base.googleCalendar', 1.3, [1540, 140], {
      operation: 'delete',
      calendar,
      eventId: "={{ $('Create Calendar Event').first().json.id }}",
      options: {},
    }, { ...retry, onError: 'continueRegularOutput', credentials: gcalCreds }),
    slack('Alert: Booking Failed', [1540, 300],
      `\`:rotating_light: Booking failed for \${${B}.name} (\${${B}.email}) at \${${B}.startUtc}. Nothing was saved; client was told to retry.\``),
    respond('Respond 502: Try Again', [1760, 300], 502, "{ ok: false, errors: ['We could not complete your booking. Please try again in a minute.'] }"),
  ],
  [
    link('Booking Request', 'Validate Booking'),
    link('Validate Booking', 'Valid?'),
    link('Valid?', 'Check Availability', 'Respond 400: Invalid'),
    link('Check Availability', 'Slot Free?', 'Alert: Booking Failed'),
    link('Slot Free?', 'Create Calendar Event', 'Respond 409: Slot Taken'),
    link('Create Calendar Event', 'Save Appointment', 'Alert: Booking Failed'),
    link('Save Appointment', 'Send Confirmation', 'Undo Calendar Event'),
    link('Send Confirmation', 'Respond 201: Booked'),
    link('Undo Calendar Event', 'Alert: Booking Failed'),
    link('Alert: Booking Failed', 'Respond 502: Try Again'),
  ],
);

// =====================================================================
// 2. REMINDERS
// =====================================================================
seq = 100;
const D = "$('Decide Reminders').item.json";
const reminders = wf(
  'Appointments: Reminders',
  [
    node('Every 15 Minutes', 'n8n-nodes-base.scheduleTrigger', 1.2, [0, 300], {
      rule: { interval: [{ field: 'minutes', minutesInterval: 15 }] },
    }),
    airtable('Upcoming Appointments (25h)', [220, 300], 'search', {
      filterByFormula: "AND({Status} = 'Confirmed', IS_AFTER({Start}, NOW()), IS_BEFORE({Start}, DATEADD(NOW(), 25, 'hours')))",
      returnAll: true,
      options: {},
    }),
    code('Decide Reminders', [440, 300], inline(['code/reminders-due.js'], `
const appointments = $input.all()
  .filter((i) => i.json.id)
  .map((i) => ({
    recordId: i.json.id,
    appointmentId: i.json['Appointment ID'],
    name: i.json.Name,
    email: i.json.Email,
    phone: i.json.Phone || null,
    service: i.json.Service,
    timezone: i.json.Timezone,
    status: i.json.Status,
    start: i.json.Start,
    createdAt: i.json['Created At'],
    reminder24hSent: i.json['Reminder 24h Sent'],
    reminder1hSent: i.json['Reminder 1h Sent'],
  }));

return remindersDue(appointments, new Date()).map((a) => {
  const when = formatLocal(a.start, a.timezone);
  const subject = a.kind === '1h'
    ? \`Starting soon: your \${a.service} at \${when}\`
    : \`Reminder: your \${a.service} is tomorrow, \${when}\`;
  const sms = a.kind === '1h'
    ? \`Hi \${a.name}, your \${a.service} starts in under an hour (\${when}). Ref \${a.appointmentId}\`
    : \`Hi \${a.name}, reminder: your \${a.service} is on \${when}. Ref \${a.appointmentId}\`;
  return { json: { ...a, when, subject, sms } };
});
`)),
    ifNode('Send a Reminder?', [660, 300], '={{ $json.kind }}', { type: 'string', operation: 'notEquals' }, 'skip-24h'),
    email('Send Reminder Email', [880, 200], '={{ $json.email }}', '={{ $json.subject }}',
      `=<p>Hi {{ $json.name }},</p>
<p>{{ $json.kind === '1h' ? 'Your appointment starts in under an hour.' : 'A quick reminder about your appointment tomorrow.' }}</p>
<ul>
  <li><strong>What:</strong> {{ $json.service }}</li>
  <li><strong>When:</strong> {{ $json.when }}</li>
  <li><strong>Reference:</strong> {{ $json.appointmentId }}</li>
</ul>
<p>Need to change it? Reply to this email.</p>`,
      { onError: 'continueErrorOutput' }),
    airtable('Mark Reminder Sent', [1100, 300], 'update', {
      columns: columns({
        id: `={{ ${D}.recordId }}`,
        'Reminder 24h Sent': `={{ ${D}.setReminder24hSent }}`,
        'Reminder 1h Sent': `={{ ${D}.setReminder1hSent }}`,
      }, ['id']),
      options: { typecast: true },
    }),
    ifNode('Send SMS Too?', [1320, 300], `={{ ${D}.kind !== 'skip-24h' && !!${D}.phone && $env.SMS_ENABLED === 'true' }}`, isTrue),
    node('Send Reminder SMS', 'n8n-nodes-base.twilio', 1, [1540, 200], {
      operation: 'send',
      from: '={{ $env.TWILIO_FROM_NUMBER }}',
      to: `={{ ${D}.phone }}`,
      message: `={{ ${D}.sms }}`,
      options: {},
    }, { ...retry, onError: 'continueRegularOutput', credentials: { twilioApi: { id: 'REPLACE_ME', name: 'Twilio account' } } }),
    slack('Alert: Reminder Failed', [1100, 480],
      `\`:warning: \${${D}.kind} reminder email failed for \${${D}.appointmentId} (\${${D}.email}). It will be retried on the next run.\``),
  ],
  [
    link('Every 15 Minutes', 'Upcoming Appointments (25h)'),
    link('Upcoming Appointments (25h)', 'Decide Reminders'),
    link('Decide Reminders', 'Send a Reminder?'),
    link('Send a Reminder?', 'Send Reminder Email', 'Mark Reminder Sent'),
    link('Send Reminder Email', 'Mark Reminder Sent', 'Alert: Reminder Failed'),
    link('Mark Reminder Sent', 'Send SMS Too?'),
    link('Send SMS Too?', 'Send Reminder SMS', null),
  ],
);
reminders.nodes.find((n) => n.name === 'Upcoming Appointments (25h)').alwaysOutputData = true;

// =====================================================================
// 3. RESCHEDULE OR CANCEL
// =====================================================================
seq = 200;
const P = "$('Plan Change').first().json";
const change = wf(
  'Appointments: Reschedule or Cancel',
  [
    webhook('Change Request', 'appointments/change', [0, 300]),
    airtable('Find Appointment', [220, 300], 'search', {
      filterByFormula: `={Appointment ID} = '${safe('$json.body.appointmentId')}'`,
      returnAll: false,
      limit: 1,
      options: {},
      // "Always output data" covers "not found". A failed call arrives as ONE
      // item carrying .error on the same output (continueRegularOutput), never
      // as an empty "not found" item plus a separate error branch.
    }, { alwaysOutputData: true, onError: 'continueRegularOutput' }),
    code('Plan Change', [440, 300], inline(['code/plan-change.js'], `
const rec = $input.first().json;
if (rec.error) {
  return [{ json: { ok: false, httpStatus: 502, error: 'Could not look up the appointment. Nothing was changed; please try again.' } }];
}
const appointment = rec.id
  ? { status: rec.Status, start: rec.Start, end: rec.End }
  : null;
const plan = planChange($('Change Request').first().json.body, appointment, new Date());
return [{ json: {
  ...plan,
  recordId: rec.id || null,
  eventId: rec['Calendar Event ID'] || null,
  appointmentId: rec['Appointment ID'] || null,
  name: rec.Name || null,
  email: rec.Email || null,
  service: rec.Service || null,
  timezone: rec.Timezone || 'Africa/Lagos',
} }];
`)),
    ifNode('Allowed?', [660, 300], '={{ $json.ok }}', isTrue),
    respond('Respond: Refused', [880, 480], '={{ $json.httpStatus }}', '{ ok: false, error: $json.error }'),
    ifNode('Cancel?', [880, 200], '={{ $json.action }}', { type: 'string', operation: 'equals' }, 'cancel'),

    // cancel
    node('Delete Calendar Event', 'n8n-nodes-base.googleCalendar', 1.3, [1100, 40], {
      operation: 'delete',
      calendar,
      eventId: `={{ ${P}.eventId }}`,
      options: { sendUpdates: 'none' },
    }, { ...retry, onError: 'continueRegularOutput', credentials: gcalCreds }),
    airtable('Mark Cancelled', [1320, 40], 'update', {
      columns: columns({
        id: `={{ ${P}.recordId }}`,
        Status: 'Cancelled',
        'Last Change': `={{ ${P}.update['Last Change'] }}`,
      }, ['id']),
      options: { typecast: true },
    }, { onError: 'continueErrorOutput' }),
    email('Send Cancellation', [1540, 40], `={{ ${P}.email }}`, `=Cancelled: your {{ ${P}.service }}`,
      `=<p>Hi {{ ${P}.name }},</p><p>Your {{ ${P}.service }} (ref {{ ${P}.appointmentId }}) has been cancelled. Reply to this email to book a new time.</p>`,
      { onError: 'continueRegularOutput' }),
    respond('Respond 200: Cancelled', [1760, 40], 200, `{ ok: true, appointmentId: ${P}.appointmentId, status: 'Cancelled' }`),

    // reschedule
    node('Move Calendar Event', 'n8n-nodes-base.googleCalendar', 1.3, [1100, 260], {
      operation: 'update',
      calendar,
      eventId: `={{ ${P}.eventId }}`,
      updateFields: {
        start: `={{ ${P}.newStartUtc }}`,
        end: `={{ ${P}.newEndUtc }}`,
      },
    }, { ...retry, onError: 'continueErrorOutput', credentials: gcalCreds }),
    airtable('Save New Time', [1320, 200], 'update', {
      columns: columns({
        id: `={{ ${P}.recordId }}`,
        Start: `={{ ${P}.update.Start }}`,
        End: `={{ ${P}.update.End }}`,
        Status: 'Confirmed',
        'Reminder 24h Sent': '={{ false }}',
        'Reminder 1h Sent': '={{ false }}',
        'Last Change': `={{ ${P}.update['Last Change'] }}`,
      }, ['id']),
      options: { typecast: true },
    }, { onError: 'continueErrorOutput' }),
    email('Send New Time', [1540, 200], `={{ ${P}.email }}`,
      `=Rescheduled: your {{ ${P}.service }} is now {{ new Date(${P}.newStartUtc).toLocaleString('en-GB', { timeZone: ${P}.timezone, dateStyle: 'full', timeStyle: 'short' }) }}`,
      `=<p>Hi {{ ${P}.name }},</p><p>Your {{ ${P}.service }} (ref {{ ${P}.appointmentId }}) has moved to <strong>{{ new Date(${P}.newStartUtc).toLocaleString('en-GB', { timeZone: ${P}.timezone, dateStyle: 'full', timeStyle: 'short' }) }}</strong> ({{ ${P}.timezone }}). You'll get fresh reminders for the new time.</p>`,
      { onError: 'continueRegularOutput' }),
    respond('Respond 200: Rescheduled', [1760, 200], 200,
      `{ ok: true, appointmentId: ${P}.appointmentId, start: ${P}.newStartUtc, end: ${P}.newEndUtc }`),
    respond('Respond 502: Calendar Error', [1320, 380], 502, "{ ok: false, error: 'Could not update the calendar. Nothing was changed; please try again.' }"),
    // The calendar already changed. The Calendar Sync workflow will pick that up
    // and correct the Airtable record within minutes, so tell the truth and alert.
    slack('Alert: Record Not Saved', [1540, 380],
      `\`:warning: \${${P}.action} of \${${P}.appointmentId} applied to Google Calendar but the Airtable update failed. Calendar Sync should reconcile it within 5 minutes; check it did.\``),
    respond('Respond 202: Saved to Calendar', [1760, 380], 202,
      `{ ok: true, appointmentId: ${P}.appointmentId, note: 'Change applied to the calendar; records are catching up.' }`),
  ],
  [
    link('Change Request', 'Find Appointment'),
    link('Find Appointment', 'Plan Change'),
    link('Plan Change', 'Allowed?'),
    link('Allowed?', 'Cancel?', 'Respond: Refused'),
    link('Cancel?', 'Delete Calendar Event', 'Move Calendar Event'),
    link('Delete Calendar Event', 'Mark Cancelled'),
    link('Mark Cancelled', 'Send Cancellation', 'Alert: Record Not Saved'),
    link('Send Cancellation', 'Respond 200: Cancelled'),
    link('Move Calendar Event', 'Save New Time', 'Respond 502: Calendar Error'),
    link('Save New Time', 'Send New Time', 'Alert: Record Not Saved'),
    link('Alert: Record Not Saved', 'Respond 202: Saved to Calendar'),
    link('Send New Time', 'Respond 200: Rescheduled'),
  ],
);

// =====================================================================
// 4. CALENDAR -> AIRTABLE SYNC
// =====================================================================
seq = 300;
const trigger = (name, triggerOn, pos) =>
  node(name, 'n8n-nodes-base.googleCalendarTrigger', 1, pos, {
    pollTimes: { item: [{ mode: 'everyX', value: 5, unit: 'minutes' }] },
    calendarId: calendar,
    triggerOn,
    options: {},
  }, { credentials: gcalCreds });

const sync = wf(
  'Appointments: Google Calendar Sync',
  [
    trigger('Event Updated', 'eventUpdated', [0, 200]),
    trigger('Event Cancelled', 'eventCancelled', [0, 400]),
    code('Normalize Event', [220, 300], `// One item per changed Google Calendar event.
return $input.all().map((i) => ({
  json: {
    eventId: i.json.id,
    cancelled: i.json.status === 'cancelled',
    start: (i.json.start && (i.json.start.dateTime || i.json.start.date)) || null,
    end: (i.json.end && (i.json.end.dateTime || i.json.end.date)) || null,
  },
}));
`),
    airtable('Find by Event ID', [440, 300], 'search', {
      filterByFormula: `={Calendar Event ID} = '${safe('$json.eventId')}'`,
      returnAll: false,
      limit: 1,
      options: {},
    }, { alwaysOutputData: true, onError: 'continueRegularOutput' }),
    code('Plan Sync', [660, 300], inline(['code/plan-change.js'], `
const event = $('Normalize Event').item.json;
const rec = $json;
// Fail loudly so the execution shows as failed in n8n, instead of a lookup
// error being mistaken for "this event isn't one of ours".
if (rec.error) throw new Error(\`Airtable lookup failed for event \${event.eventId}: \${rec.error}\`);
if (!rec.id) return { json: { skip: true, reason: 'event not created by this system' } };
const update = planCalendarSync(event, { status: rec.Status, start: rec.Start, end: rec.End });
if (!update) return { json: { skip: true, reason: 'already in sync' } };
return { json: { id: rec.id, ...update } };
`), 'runOnceForEachItem'),
    ifNode('Needs Update?', [880, 300], '={{ $json.skip }}', { type: 'boolean', operation: 'false', singleValue: true }),
    airtable('Apply Calendar Change', [1100, 200], 'update', {
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: ['id'], schema: [] },
      options: { typecast: true },
    }),
  ],
  [
    link('Event Updated', 'Normalize Event'),
    link('Event Cancelled', 'Normalize Event'),
    link('Normalize Event', 'Find by Event ID'),
    link('Find by Event ID', 'Plan Sync'),
    link('Plan Sync', 'Needs Update?'),
    link('Needs Update?', 'Apply Calendar Change', null),
  ],
);

// ---------- write ----------
const out = path.join(root, 'workflows');
fs.mkdirSync(out, { recursive: true });
for (const [file, w] of [
  ['1-book.json', book],
  ['2-reminders.json', reminders],
  ['3-reschedule-or-cancel.json', change],
  ['4-google-calendar-sync.json', sync],
]) {
  const names = new Set(w.nodes.map((n) => n.name));
  if (names.size !== w.nodes.length) throw new Error(`${file}: duplicate node names`);
  for (const [src, c] of Object.entries(w.connections)) {
    if (!names.has(src)) throw new Error(`${file}: connection from unknown node ${src}`);
    for (const out2 of c.main) for (const t of out2) if (!names.has(t.node)) throw new Error(`${file}: connection to unknown node ${t.node}`);
  }
  fs.writeFileSync(path.join(out, file), JSON.stringify(w, null, 2) + '\n');
  console.log(`built workflows/${file} (${w.nodes.length} nodes)`);
}
