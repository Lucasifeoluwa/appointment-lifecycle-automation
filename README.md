# Appointment Lifecycle Automation (n8n + Airtable + Google Calendar)

Bookings come in through an API, get checked against the real calendar, and are confirmed by email. Clients are reminded 24 hours and 1 hour before. Reschedules and cancellations update the calendar, the records and the client in one step, and changes made directly in Google Calendar flow back automatically. Nobody re-types anything.

Built with **n8n**, **Airtable**, **Google Calendar**, SMTP email, optional **Twilio** SMS, and unit-tested JavaScript.

---

## The problem

A service business taking bookings by WhatsApp, forms and phone ends up with the calendar, the client list and the reminders all maintained by hand. Double-bookings happen, reminders get forgotten so clients no-show, and when someone moves an appointment in the calendar the records no longer match.

## What this does

Four workflows, one Airtable table as the source of truth.

**1. Book** (`POST /webhook/appointments/book`)

```
request ─▶ validate (fields, UTC offset, lead time) ──invalid──▶ 400 + every error
               │
               ▼
     Google free/busy for the slot ──busy──▶ 409 slot taken
               │ free                     ──error──▶ Slack alert ─▶ 502
               ▼
     create calendar event ──fails──▶ Slack alert ─▶ 502
               │
               ▼
     save to Airtable ──fails──▶ delete the calendar event (undo) ─▶ Slack ─▶ 502
               │
               ▼
     confirmation email ─▶ 201 { appointmentId, start, end }
```

**2. Reminders** (every 15 minutes)

Finds confirmed appointments starting in the next 25 hours, decides which reminder each needs, sends it by email (and SMS if enabled), then ticks the flag so it is never sent twice.

**3. Reschedule or Cancel** (`POST /webhook/appointments/change`)

Looks up the appointment, checks the change is allowed (exists, not already cancelled, not in the past, new time valid), then updates Google Calendar, Airtable and the client. Rescheduling resets both reminder flags so the new time gets fresh reminders.

**4. Google Calendar Sync** (polls every 5 minutes)

When someone drags an event to a new time or deletes it in Google Calendar, the matching Airtable record is updated (or cancelled) and the reminders are reset. This makes the sync two-way.

## Design decisions

**Times must carry a UTC offset.** `2026-11-20T14:00:00+01:00` is accepted; `2026-11-20T14:00` is rejected with a clear message. Without an offset the server has to guess the timezone, and the client turns up an hour off. Everything is stored and compared in UTC. The client's IANA timezone is kept only to show their local time in messages.

**Reminders are flag-driven, not timer-driven.** The scheduler doesn't try to fire at an exact moment. Each run asks: "is this appointment inside the 24h (or 1h) window, and has that reminder not been sent?" So a late run, a double run or a missed run never double-sends or silently skips. Two edge cases are handled deliberately:
- **Inside the last hour with no 24h reminder sent:** only the 1h reminder goes out, and the 24h one is closed off. Two reminders minutes apart is noise.
- **Booked less than 24 hours ahead:** the 24h reminder is skipped. The confirmation email just went out.

**Conflict checks use Google's free/busy API, not "list events".** Listing events returns nothing when the slot is free. Handling that in n8n needs *Always Output Data*, and I found in testing that when the call then *fails*, n8n sends an empty item down the success path as well as the error path. A failed check would read as "slot free" and double-book. Free/busy always returns exactly one answer, `{ available: true | false }`, so a failure can only go down the error path.

**Undo on partial failure.** If the calendar event is created but the Airtable write fails after 3 retries, the workflow deletes the event it just made, so nothing is half-booked, and returns a 502 asking the client to retry.

**Self-healing when the calendar is ahead of the records.** If a reschedule or cancel updates Google Calendar but the Airtable write fails, the client gets a `202` (honest: the change is real), Slack gets an alert, and the Calendar Sync workflow reconciles the record on its next poll.

**No sync loops.** When workflow 3 moves an event, Google Calendar reports the change and workflow 4 fires. It compares the event with the Airtable record, finds them already equal, and does nothing. That comparison is a pure function with its own tests.

**Honest HTTP responses.** `201` booked, `400` invalid input (all errors at once), `404` unknown appointment, `409` slot taken / already cancelled / already started, `502` an upstream service failed and nothing changed. Every external call that runs before a response has an error branch, because an n8n webhook that errors before reaching a Respond node returns an empty `200`, which a client would read as success.

**Safe Airtable formulas.** IDs from requests are stripped to `[A-Za-z0-9_-]` before going into a `filterByFormula`, so a crafted ID cannot rewrite the query.

**Tested logic, injected into n8n.** The decision logic is plain JavaScript in `code/` with 19 unit tests. `scripts/build-workflows.js` pastes that exact source into the Code nodes, so what is tested is what runs.

## API

**Book**

```bash
curl -X POST http://localhost:5678/webhook/appointments/book \
  -H 'content-type: application/json' -d @samples/book.json
```
```json
{ "ok": true, "appointmentId": "APT-MHZ3L1TR-YYZV", "start": "2026-11-20T13:00:00.000Z", "end": "2026-11-20T13:45:00.000Z" }
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | |
| `email` | yes | |
| `start` | yes | ISO 8601 **with offset**, at least 15 minutes ahead |
| `durationMins` | no | 15–240, default 30 |
| `service` | no | default `Consultation` |
| `phone` | no | international format, for SMS reminders |
| `timezone` | no | IANA name, default `Africa/Lagos` |

**Reschedule / cancel**

```bash
curl -X POST http://localhost:5678/webhook/appointments/change \
  -H 'content-type: application/json' \
  -d '{"appointmentId":"APT-MHZ3L1TR-YYZV","action":"reschedule","newStart":"2026-11-21T10:00:00+01:00"}'

curl -X POST http://localhost:5678/webhook/appointments/change \
  -H 'content-type: application/json' \
  -d '{"appointmentId":"APT-MHZ3L1TR-YYZV","action":"cancel"}'
```

## Repository layout

```
code/
  validate-booking.js    booking validation and UTC normalisation
  reminders-due.js       which reminder each appointment needs now
  plan-change.js         reschedule/cancel rules and calendar-sync comparison
test/logic.test.js       19 node:test unit tests, no dependencies
workflows/               n8n exports, generated by scripts/build-workflows.js
airtable/schema.md       the Appointments table, field by field
samples/                 example request bodies
docker-compose.yml       local n8n, pinned to the tested version
```

## Run it locally

**You need:** Docker, Node 18+, a Google account, a free Airtable account, SMTP details, a Slack incoming webhook, and optionally a Twilio account.

1. `cp .env.example .env` and fill it in. `GOOGLE_CALENDAR_ID` must be the email-style ID (your Gmail address, or `...@group.calendar.google.com`), not `primary`.
2. Create the Airtable table from `airtable/schema.md`.
3. `docker compose up -d` and open http://localhost:5678.
4. In n8n, add credentials: *Airtable Personal Access Token*, *Google Calendar OAuth2*, *SMTP*, and *Twilio* if you want SMS.
5. Import the four files in `workflows/`, then select your credentials on each Airtable, Google Calendar, Send Email and Twilio node.
6. Activate all four workflows.
7. `npm test`, then book with `samples/book.json` and watch the event appear in Google Calendar and the row in Airtable.

## Verified

Tested on **n8n 1.123.92** (pinned in `docker-compose.yml`):

| Check | Result |
| --- | --- |
| All four workflows import with `n8n import:workflow` | Pass |
| Book and Change webhooks activate | Pass |
| Invalid booking → `400` listing all four errors, straight from the tested validation code | Pass |
| Valid booking with Google Calendar unreachable → Slack alert → `502`; never reaches event creation | Pass |
| Change request with Airtable unreachable → exactly one `502` | Pass |
| Unit tests (`npm test`) | 19/19 pass |

The calendar, Airtable, email and SMS steps need your own accounts; follow *Run it locally* to exercise them end to end.

## Known limitations

- **Two bookings for the same slot within a second** could both pass the free/busy check before either event exists. Fine for a small practice; under real load the check-and-create would sit behind a lock or a queue.
- **Reschedules don't run a conflict check.** A free/busy check over the new slot would count the appointment's own current event as busy whenever the old and new times overlap. The fix is to list events in the new slot and ignore its own event id; not yet done.
- **Reminder sent, flag not saved.** If the email goes out but the Airtable update fails 3 times, the next run sends that reminder again. Duplicate-over-missed is the deliberate trade-off.
- **Calendar Sync is polling-based**, so a change made directly in Google Calendar reaches Airtable within about 5 minutes, not instantly.

## Tech

n8n · Airtable · Google Calendar API (events, free/busy) · SMTP · Twilio · Slack incoming webhooks · Node.js (`Intl`, `node:test`) · Docker

## License

MIT
