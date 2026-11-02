# Airtable schema

One base, one table. Create it before importing the workflows.

## Table: `Appointments`

| Field | Type | Notes |
| --- | --- | --- |
| `Appointment ID` | Single line text | **Primary field.** Generated at booking, e.g. `APT-MHZ3L1TR-YYZV`. The client quotes it to reschedule or cancel. |
| `Name` | Single line text | |
| `Email` | Email | Lower-cased at booking |
| `Phone` | Phone number | International format, `+234...`. Optional. |
| `Service` | Single line text | Defaults to `Consultation` |
| `Start` | Date (include time, **GMT/UTC**) | Stored in UTC. Never convert this field to a local timezone. |
| `End` | Date (include time, **GMT/UTC**) | |
| `Duration (mins)` | Number | |
| `Timezone` | Single line text | Client's IANA timezone, e.g. `Africa/Lagos`. Used only to display times in messages. |
| `Status` | Single select | Options: `Confirmed`, `Cancelled` |
| `Calendar Event ID` | Single line text | Google Calendar event id. Links the record to the event for updates and sync. |
| `Reminder 24h Sent` | Checkbox | Set by the reminder workflow; reset on reschedule |
| `Reminder 1h Sent` | Checkbox | Set by the reminder workflow; reset on reschedule |
| `Created At` | Date (include time, GMT/UTC) | When the booking was made. Used to skip a pointless 24h reminder for last-minute bookings. |
| `Last Change` | Long text | What last changed and when, e.g. `Rescheduled 2026-11-02T... (was ...)` |

## Suggested views

- **Upcoming**: `Status = Confirmed` and `Start` is after now, sorted by `Start`.
- **Changed recently**: sorted by `Last Change`, to see reschedules and calendar edits.

## Why UTC everywhere

The reminder workflow compares `Start` with "now" every 15 minutes. If `Start` were stored in local time and the n8n server ran in another timezone, reminders would fire an hour early or late. Everything is stored and compared in UTC; the client's timezone is applied only when writing a message.
