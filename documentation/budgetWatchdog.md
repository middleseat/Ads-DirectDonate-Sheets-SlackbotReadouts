# Budget Watchdog

`budgetWatchdog/budgetWatchdog.gs` is a companion to the readout bot. It watches the campaign budget block on the `FB_data` tab and posts to Slack when a campaign is close to — or already past — its spend cap, on a schedule, without anyone opening the sheet.

It is a separate script with its own version number and its own configuration. It shares only one thing with the readout bot: the `SLACK_OAUTH_TOKEN` script property.

## What It Posts

One message per run, with a section per flagged campaign, most urgent first:

> :rotating_light: **Ohio Senate — Prospecting has hit its budget cap**
> Spent $24,980 of $25,000 • status: PAUSED
> `2024_OH_Senate_Prospecting_Conversions`
>
> :warning: **Ohio Senate — Retargeting is within 10% of budget cap**
> Spent $8,900 of $10,000 • $1,100 left (11.0%) • status: ACTIVE
> `2024_OH_Senate_Retargeting_Conversions`

Two severities:

- **:rotating\_light: Out of budget** — nothing meaningful left against the cap. These repeat on every run until the situation changes, because they are worth repeating.
- **:warning: Within 10% of cap** — still spending, but close. These go out **once per campaign per day**, so a campaign sitting in the warning band does not generate four identical messages.

When there is nothing new to report, the script posts nothing at all rather than sending an empty message.

## Setup

1. **Add the script.** Create a new script file in the same Apps Script project as the readout bot (Extensions > Apps Script) and paste in the contents of `budgetWatchdog.gs`.

2. **Enable the Sheets advanced service.** In the Apps Script editor, click **Services**, add **Google Sheets API**, and leave the identifier as `Sheets`.

   This is not optional on a large tracker. `SpreadsheetApp` has to load the entire document before it can hand back a single cell, and a document with 100k+ rows on `FB_data` and 40+ tabs times out on the load itself — *"Service Spreadsheets failed while accessing document with id ..."*. The Sheets API fetches only the requested range and is unaffected by document size. The script falls back to `SpreadsheetApp` with a warning in the log if the service is missing, which works on small documents and fails on large ones.

3. **Set the channel.** Update `WATCHDOG_SLACK_CHANNEL_ID` with your channel ID. A channel ID starts with `C` — an ID starting with `U` is a person, and the alerts will go to them as a DM instead of to a channel.

4. **Confirm the token.** The script reads the same `SLACK_OAUTH_TOKEN` script property as the readout bot. If readouts are already posting, this is already done.

5. **Check what it would send.** Run `previewBudgetWatchdog()` from the editor. It logs every alert it would post, applying the same once-a-day filter as a real run, without posting anything and without marking anything as sent.

6. **Schedule it.** Run `installWatchdogTriggers()` once. It installs the daily triggers listed in `WATCHDOG_RUN_TIMES` and is safe to re-run — existing watchdog triggers are cleared first, so you never end up with duplicates. Apps Script fires time-based triggers within roughly 15 minutes of the requested time.

Adding this script introduces a trigger authorization scope, so the first run will ask you to reauthorize the project.

## The Sheet Block

The script reads an 11-column block, `AE:AO`, starting at row 3 (row 2 is the header).

| Column | Contents | How it is used |
| --- | --- | --- |
| AE | Campaign name | Shown in backticks; used as the label if AN is blank |
| AF | Campaign status | Appended to the detail line when it is not `ACTIVE` |
| AG | Campaign budget remaining | Last-resort fallback for money left |
| AH | Campaign spending limit | The cap. Denominator for "% remaining" |
| AI | Campaign end date | Not read directly — reaches Slack through AO's text |
| AJ | Cost | Spend to date |
| AK | True Remainder | **Preferred** source for money left |
| AL | Low Budget | **The trigger.** Only rows reading `Yes` are considered |
| AM | Ending Soon | Not read directly — reaches Slack through AO's text |
| AN | Shortname | Preferred label in the alert headline |
| AO | Flags | Preferred alert text |

Two deliberate fallbacks keep alerts working when the sheet's own helper columns have not calculated:

- **Money left** comes from AK when it has a value, otherwise `AH - AJ`, otherwise AG.
- **Alert text** comes from AO when it has a value, otherwise the script writes its own headline. When a campaign is genuinely spent out, the script rewrites AO's *"is within 10% of budget cap"* wording to *"has hit its budget cap"*, since column AO words every budget flag the same way.

## Why Some Flagged Rows Are Skipped

A campaign flagged in AL is **dropped** when its remainder is more negative than `WATCHDOG_STALE_LIMIT_OVERSPEND` (default $100).

The spend cap in AH refreshes once a day while spend updates hourly. A cap raised this morning leaves the sheet comparing today's spend against yesterday's limit, so AL latches to `Yes` and stays there until the next refresh — alerting on every run, all day, about a campaign that has plenty of budget. A campaign that genuinely runs out lands just past zero, because Meta stops delivery at the cap. A hole much larger than that means the campaign is spending against a higher limit the sheet has not picked up yet.

Skipped rows are never dropped silently — the campaign and its remainder are written to the log so it stays findable.

## Configuration

| Constant | Default | Purpose |
| --- | --- | --- |
| `WATCHDOG_SLACK_CHANNEL_ID` | `'U0127C7UF16'` | Where alerts go. Use a `C…` channel ID |
| `WATCHDOG_SLACK_THREAD_URL` | `''` | Optional thread to post into. Needs a `thread_ts` in the URL |
| `WATCHDOG_SHEET_NAME` | `'FB_data'` | Tab holding the budget block |
| `WATCHDOG_FIRST_COLUMN` | `'AE'` | Left-most column of the block |
| `WATCHDOG_FIRST_DATA_ROW` | `3` | First row of data |
| `WATCHDOG_MAX_ROWS_TO_SCAN` | `200` | Safety bound — `FB_data` runs to 100k+ rows of ad-level data |
| `WATCHDOG_CRITICAL_PCT_REMAINING` | `0.001` | At or below this share of the cap counts as fully out of budget |
| `WATCHDOG_STALE_LIMIT_OVERSPEND` | `100` | Overspent by more than this reads as a stale cap, not a spent-out one |
| `WATCHDOG_TIMEZONE` | `''` | Optional, e.g. `'America/New_York'`. Blank uses the script's timezone |
| `WATCHDOG_RUN_TIMES` | 9:00, 12:00, 15:00, 17:30 | Daily run schedule |

If the campaign list ever grows past `WATCHDOG_MAX_ROWS_TO_SCAN`, the script warns in the log rather than truncating quietly.

## Functions You Can Run

| Function | What it does |
| --- | --- |
| `runBudgetWatchdog()` | A full run. This is what the triggers call |
| `previewBudgetWatchdog()` | Logs what a run would post, without posting or recording anything |
| `installWatchdogTriggers()` | Installs the daily schedule. Safe to re-run |
| `listWatchdogTriggers()` | Logs the currently installed watchdog triggers |
| `removeWatchdogTriggers()` | Deletes every watchdog trigger. Returns the count removed |
| `resetWatchdogWarnedToday()` | Clears today's warning history so the next run re-sends every 10% warning. For testing — a normal day resets on its own |

## Troubleshooting

**Nothing posted.** Check the execution log. "Nothing new to report" means either no row in AL reads `Yes`, or every warning has already gone out today. `resetWatchdogWarnedToday()` clears the latter.

**"Service Spreadsheets failed while accessing document with id ..."** The Sheets advanced service is not enabled, so the script fell back to `SpreadsheetApp` and timed out loading the document. See step 2. The script retries twice, at 5 and 15 seconds, before giving up.

**The same warning arrives repeatedly.** Only out-of-budget alerts repeat by design. If a 10% warning is repeating, the once-a-day record failed to save — the log will say so.

**Alerts for campaigns with budget left.** That is the stale-cap case above. Lower `WATCHDOG_STALE_LIMIT_OVERSPEND` to drop them sooner.

**The warning history** lives in the `WATCHDOG_WARNED_TODAY` script property as `{date, campaigns}`. Anything stored under a previous date is ignored, so the list resets itself on the first run of each day with no cleanup.
