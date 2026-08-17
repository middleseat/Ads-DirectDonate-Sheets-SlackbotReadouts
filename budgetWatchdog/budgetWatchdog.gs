/**
 * Budget Watchdog for Google Sheets
 * Version: 1.2.0
 * Author: Ryan Mioduski
 *
 * Monitors the FB_data tab for campaigns that are close to — or already past —
 * their spend cap and posts an alert to Slack.
 *
 * Alert cadence: a 10%-of-cap warning goes out once per campaign per day, while an
 * out-of-budget alert repeats on every run. That asymmetry is deliberate, and the whole
 * reasoning lives in dropWarningsAlreadySentToday() — it comes down to what the sheet can
 * and cannot tell us about a cap that may have been raised since the last run.
 *
 * Important:
 *   1. Enable the Sheets advanced service — Apps Script editor > Services > Sheets.
 *      Without it the script falls back to SpreadsheetApp, which has to load this
 *      entire tracker before reading a cell and times out on a document this size.
 *   2. Run installWatchdogTriggers() once to schedule the automatic runs.
 *
 */

// Configuration to update
const WATCHDOG_SLACK_CHANNEL_ID = 'U0127C7UF16'; // Update this with your channel ID
const WATCHDOG_SLACK_THREAD_URL = ''; // Optional: Update this with your thread URL if you want to post to a specific thread

// Configuration you probably do not need to change
const WATCHDOG_SHEET_NAME = 'FB_data'; // The name of the sheet holding the campaign budget block
const WATCHDOG_FIRST_COLUMN = 'AE'; // Left-most column of the watch block (AE:AO)
const WATCHDOG_FIRST_DATA_ROW = 3; // First row of data (row 2 is the header)
const WATCHDOG_MAX_ROWS_TO_SCAN = 200; // Safety bound — FB_data runs to 100k+ rows of ad-level data
const WATCHDOG_CRITICAL_PCT_REMAINING = 0.01; // At or below this share of the cap counts as out of budget, and the alert says exactly that rather than quoting the percentage. Meta often leaves the last few dollars of a cap unspent, so waiting for a true zero means the alert never fires on a campaign that has already stopped delivering
const WATCHDOG_STALE_LIMIT_OVERSPEND = 100; // Overspent by more than this means the cap was raised and the sheet has not caught up, not that the campaign is spent out — see getWatchdogAlerts()
const WATCHDOG_TIMEZONE = ''; // Optional: e.g. 'America/New_York'. Blank uses the script's timezone
const WATCHDOG_RUN_TIMES = [ // Daily run schedule (24-hour clock)
  { hour: 9, minute: 0 },
  { hour: 12, minute: 0 },
  { hour: 15, minute: 0 },
  { hour: 17, minute: 30 }
];
// End Configuration

const WATCHDOG_TRIGGER_HANDLER = 'runBudgetWatchdog';
const WATCHDOG_COLUMN_COUNT = 11; // AE through AO
const WATCHDOG_WARNED_TODAY_KEY = 'WATCHDOG_WARNED_TODAY'; // Script property holding the campaigns already warned about today

// Offsets within the AE:AO block
const WATCHDOG_COL = {
  CAMPAIGN: 0,         // AE - Campaign name
  STATUS: 1,           // AF - Campaign status
  BUDGET_REMAINING: 2, // AG - Campaign budget remaining
  SPENDING_LIMIT: 3,   // AH - Campaign spending limit
  END_DATE: 4,         // AI - Campaign end date
  COST: 5,             // AJ - Cost
  TRUE_REMAINDER: 6,   // AK - True Remainder
  LOW_BUDGET: 7,       // AL - Low Budget
  ENDING_SOON: 8,      // AM - Ending Soon
  SHORTNAME: 9,        // AN - Shortname
  FLAG: 10             // AO - Flags
};

/**
 * Trigger entry point. Reads the watch block, classifies anything flagged in
 * column AL, and posts to Slack.
 */
function runBudgetWatchdog() {
  console.log('Budget Watchdog starting');

  const alerts = getWatchdogAlerts();
  console.log(`Flagged campaigns: ${alerts.length}`);

  const toPost = dropWarningsAlreadySentToday(alerts);
  if (toPost.length === 0) {
    console.log('Nothing new to report. Skipping Slack message.');
    return;
  }

  const posted = postWatchdogToSlack(toPost);
  if (posted) {
    // Only after the message lands — recording a warning we failed to send would
    // silence it for the rest of the day.
    recordWatchdogWarningsSent(toPost);
  }
  console.log(posted ? 'Budget Watchdog message sent.' : 'Budget Watchdog message failed. See logs above.');
}

/**
 * Logs what would be sent without posting to Slack. Handy for verifying setup.
 * Applies the same once-a-day filter as a real run, so what you see here is what
 * the next run would actually post. Reading the filter does not update it.
 */
function previewBudgetWatchdog() {
  const alerts = dropWarningsAlreadySentToday(getWatchdogAlerts());
  if (alerts.length === 0) {
    console.log('Nothing would be sent — either no campaigns are flagged in column AL, or every warning has already gone out today.');
    return;
  }

  alerts.forEach(alert => {
    console.log(`[${alert.severity}] ${alert.emoji} ${alert.message}`);
    console.log(`         ${alert.detail}`);
  });
}

/**
 * Drops 10%-of-cap warnings that already went out today.
 *
 * Meta only refreshes a campaign's effective status and spend cap (column AH) once a day,
 * while spend updates hourly and this script runs four times a day. So when a campaign is
 * sitting in the warning band, the script has no way to tell whether someone has already
 * raised the cap: the sheet reports yesterday's limit either way, and column AL stays
 * latched to "Yes" until the next refresh. Repeating the warning would just be the same
 * guess three or four more times. One per campaign per day is enough — the next day's
 * refresh clears the slate, and the warning fires again if it is still true.
 *
 * Out-of-budget alerts are deliberately exempt, because there the sheet does eventually
 * answer the question:
 *
 *   - If the cap was never raised, the campaign stays pinned within
 *     WATCHDOG_CRITICAL_PCT_REMAINING of the limit. Repeating is correct, because it is
 *     still out of budget.
 *   - If the cap *was* raised, spend keeps climbing past the stale limit, the remainder
 *     turns negative, and the stale-cap check in getWatchdogAlerts() drops the row before
 *     it ever reaches this function.
 *
 * A negative remainder is the one unambiguous signal that someone has already fixed the
 * budget, and only a raised cap can produce it. That is what makes repeating safe: the
 * alert stops on its own as soon as it stops being true, without this function having to
 * guess. Worth knowing about the lag, though — the exemption only kicks in once spend has
 * passed the stale cap by more than WATCHDOG_STALE_LIMIT_OVERSPEND, so a cap raised this
 * morning can still produce an alert or two before the overspend shows up.
 */
function dropWarningsAlreadySentToday(alerts) {
  const warned = readWatchdogWarnedToday();
  if (warned.length === 0) return alerts;

  const suppressed = [];
  const kept = alerts.filter(alert => {
    if (alert.severity !== 'warning') return true;
    if (warned.indexOf(alert.campaign) === -1) return true;
    suppressed.push(alert.campaign);
    return false;
  });

  // Never suppress silently — the campaign should still be findable in the log.
  if (suppressed.length > 0) {
    console.log(`Suppressed ${suppressed.length} warning(s) already sent today: ${suppressed.join(', ')}`);
  }

  return kept;
}

/**
 * Adds the warnings in this message to today's list.
 */
function recordWatchdogWarningsSent(alerts) {
  const warned = readWatchdogWarnedToday();

  alerts.forEach(alert => {
    if (alert.severity === 'warning' && warned.indexOf(alert.campaign) === -1) {
      warned.push(alert.campaign);
    }
  });

  const state = { date: watchdogToday(), campaigns: warned };

  try {
    PropertiesService.getScriptProperties().setProperty(WATCHDOG_WARNED_TODAY_KEY, JSON.stringify(state));
  } catch (error) {
    // The message is already out. Failing here at worst repeats a warning on the next
    // run, which is not worth turning a delivered alert into a failed execution.
    console.warn(`Could not record today's warnings (${error}). They may be sent again on the next run.`);
  }
}

/**
 * The campaigns already warned about today. Anything stored under a previous date is
 * dropped, so the list resets itself on the first run of each day with no cleanup.
 */
function readWatchdogWarnedToday() {
  const raw = PropertiesService.getScriptProperties().getProperty(WATCHDOG_WARNED_TODAY_KEY);
  if (!raw) return [];

  try {
    const state = JSON.parse(raw);
    if (state.date !== watchdogToday()) return [];
    return state.campaigns || [];
  } catch (error) {
    // A warning sent twice beats a warning never sent, so fall back to sending.
    console.warn(`Could not read ${WATCHDOG_WARNED_TODAY_KEY} (${error}). Treating today as unwarned.`);
    return [];
  }
}

/**
 * Clears today's warning history so the next run re-sends every 10% warning.
 * For testing — a normal day resets on its own.
 */
function resetWatchdogWarnedToday() {
  PropertiesService.getScriptProperties().deleteProperty(WATCHDOG_WARNED_TODAY_KEY);
  console.log('Cleared today\'s warning history. The next run will send every flagged warning again.');
}

/**
 * Reads the AE:AO block and returns one alert object per campaign flagged in
 * column AL, sorted most urgent first.
 *
 * Rows whose remainder is deeply negative are dropped, and that check does double duty.
 * The campaign spending limit (column AH) only refreshes once a day, so a cap raised this
 * morning leaves the sheet comparing today's spend against yesterday's limit — column AL
 * latches to "Yes" and stays there until the next refresh, alerting on every run all day.
 * A campaign that genuinely runs out lands just past zero, because Meta stops delivery at
 * the cap; a hole larger than WATCHDOG_STALE_LIMIT_OVERSPEND means the campaign is spending
 * against a higher limit the sheet has not picked up yet.
 *
 * Because only a raised cap can put a campaign that far past its limit, that same hole is
 * the signal that the budget has already been fixed — which is what lets out-of-budget
 * alerts repeat every run without turning into noise. See dropWarningsAlreadySentToday().
 */
function getWatchdogAlerts() {
  const values = readWatchdogRows();
  if (values.length === 0) {
    console.log('No data returned from the watch range.');
    return [];
  }

  // Never truncate silently: warn if the campaign list may run past the scan window.
  const lastScannedCampaign = watchdogToText(values[values.length - 1][WATCHDOG_COL.CAMPAIGN]);
  if (values.length >= WATCHDOG_MAX_ROWS_TO_SCAN && lastScannedCampaign) {
    console.warn(`Campaign data still present at the end of the ${WATCHDOG_MAX_ROWS_TO_SCAN}-row scan window. Increase WATCHDOG_MAX_ROWS_TO_SCAN.`);
  }

  const alerts = [];
  const staleLimitRows = [];
  values.forEach((row, index) => {
    const campaign = watchdogToText(row[WATCHDOG_COL.CAMPAIGN]);
    if (!campaign) return; // Blank campaign name means there is nothing to evaluate

    if (watchdogToText(row[WATCHDOG_COL.LOW_BUDGET]).toLowerCase() !== 'yes') return;

    const remaining = watchdogRemaining(row);
    if (remaining !== null && remaining < -WATCHDOG_STALE_LIMIT_OVERSPEND) {
      staleLimitRows.push(`${campaign} (${watchdogFormatCurrency(remaining)})`);
      return;
    }

    alerts.push(buildWatchdogAlert(row, campaign, WATCHDOG_FIRST_DATA_ROW + index));
  });

  // Never drop rows silently — a campaign that is genuinely overspent by this much
  // should still be findable in the log.
  if (staleLimitRows.length > 0) {
    console.log(`Skipped ${staleLimitRows.length} flagged campaign(s) overspent by more than ${watchdogFormatCurrency(WATCHDOG_STALE_LIMIT_OVERSPEND)}, which reads as a stale spending limit rather than a spent-out cap: ${staleLimitRows.join(', ')}`);
  }

  // Out-of-budget first, then by how little is left.
  alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'critical' ? -1 : 1;
    return a.pctRemaining - b.pctRemaining;
  });

  return alerts;
}

/**
 * Fetches the AE:AO watch block as a 2D array.
 *
 * This goes through the Sheets API rather than SpreadsheetApp on purpose. SpreadsheetApp
 * has to load the entire document before it can hand back a single cell, and this
 * tracker is large enough (100k+ rows on FB_data alone, 40+ tabs) that the load itself
 * times out — "Service Spreadsheets failed while accessing document with id ...". The
 * Sheets API fetches only the requested range and is unaffected by document size.
 *
 * Requires the Sheets advanced service (Extensions > Apps Script > Services > Sheets).
 * Falls back to SpreadsheetApp if it is not enabled, which works but is what fails on
 * large documents.
 */
function readWatchdogRows() {
  const firstColumnIndex = watchdogColumnToIndex(WATCHDOG_FIRST_COLUMN);
  const lastColumn = watchdogIndexToColumn(firstColumnIndex + WATCHDOG_COLUMN_COUNT - 1);
  const lastRow = WATCHDOG_FIRST_DATA_ROW + WATCHDOG_MAX_ROWS_TO_SCAN - 1;
  const a1Range = `${WATCHDOG_SHEET_NAME}!${WATCHDOG_FIRST_COLUMN}${WATCHDOG_FIRST_DATA_ROW}:${lastColumn}${lastRow}`;

  return watchdogWithRetry(`read ${a1Range}`, () => {
    if (typeof Sheets === 'undefined') {
      console.warn('Sheets advanced service is not enabled — falling back to SpreadsheetApp, which loads the whole document.');
      const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(WATCHDOG_SHEET_NAME);
      if (!sheet) {
        throw new Error(`Sheet "${WATCHDOG_SHEET_NAME}" not found.`);
      }
      return sheet.getRange(WATCHDOG_FIRST_DATA_ROW, firstColumnIndex, WATCHDOG_MAX_ROWS_TO_SCAN, WATCHDOG_COLUMN_COUNT).getValues();
    }

    const response = Sheets.Spreadsheets.Values.get(watchdogSpreadsheetId(), a1Range, {
      valueRenderOption: 'UNFORMATTED_VALUE'
    });
    // The API omits trailing empty cells and rows, so rows can be short. Every reader
    // below goes through watchdogToText/watchdogToNumber, both of which treat a missing
    // cell the same as a blank one.
    return response.values || [];
  });
}

/**
 * Retries an operation a couple of times before giving up. The Spreadsheets and Sheets
 * services both fail intermittently on documents this size, and a retry usually clears
 * it. Delays are deliberately short — triggers get roughly six minutes total.
 */
function watchdogWithRetry(label, operation) {
  const delaysMs = [5000, 15000];

  for (let attempt = 0; ; attempt++) {
    try {
      return operation();
    } catch (error) {
      if (attempt >= delaysMs.length) {
        console.error(`Giving up on ${label} after ${attempt + 1} attempts.`);
        throw error;
      }
      console.warn(`Attempt ${attempt + 1} to ${label} failed: ${error}. Retrying in ${delaysMs[attempt] / 1000}s.`);
      Utilities.sleep(delaysMs[attempt]);
    }
  }
}

function watchdogSpreadsheetId() {
  return SpreadsheetApp.getActiveSpreadsheet().getId();
}

// Only used for the Slack notification preview, so a failure here must not lose the alert.
function watchdogDocumentTitle() {
  try {
    return SpreadsheetApp.getActiveSpreadsheet().getName();
  } catch (error) {
    console.warn(`Could not read the document name: ${error}`);
    return 'Campaign';
  }
}

/**
 * The money actually left on a row. Prefers the sheet's own True Remainder (column AK)
 * and falls back to the same logic it uses when that cell has not calculated: with a
 * spending limit set, remaining is limit minus spend; without one, it is the campaign's
 * remaining budget. Returns null when there is nothing to go on.
 */
function watchdogRemaining(row) {
  const trueRemainder = watchdogToNumber(row[WATCHDOG_COL.TRUE_REMAINDER]);
  if (trueRemainder !== null) return trueRemainder;

  const spendingLimit = watchdogToNumber(row[WATCHDOG_COL.SPENDING_LIMIT]);
  if (spendingLimit !== null) return spendingLimit - (watchdogToNumber(row[WATCHDOG_COL.COST]) || 0);

  return watchdogToNumber(row[WATCHDOG_COL.BUDGET_REMAINING]);
}

/**
 * Turns one flagged row into an alert, deciding severity from the money actually
 * left against the cap.
 */
function buildWatchdogAlert(row, campaign, rowNumber) {
  const spendingLimit = watchdogToNumber(row[WATCHDOG_COL.SPENDING_LIMIT]);
  const cost = watchdogToNumber(row[WATCHDOG_COL.COST]);
  const status = watchdogToText(row[WATCHDOG_COL.STATUS]);
  const shortname = watchdogToText(row[WATCHDOG_COL.SHORTNAME]);
  const flagText = watchdogToText(row[WATCHDOG_COL.FLAG]);

  const remaining = watchdogRemaining(row);

  // Percentages need a denominator: the cap when one is set, otherwise spend-to-date
  // plus whatever is left, which is the closest thing to a total this campaign has.
  let basis = spendingLimit;
  if (basis === null || basis <= 0) {
    basis = (cost || 0) + (remaining || 0);
  }
  const pctRemaining = basis > 0 && remaining !== null ? remaining / basis : 0;

  const outOfBudget = remaining === null || remaining <= 0 || pctRemaining <= WATCHDOG_CRITICAL_PCT_REMAINING;
  const severity = outOfBudget ? 'critical' : 'warning';

  // Prefer the sheet's own flag text; fall back if column AO has not calculated.
  const label = shortname || campaign;
  let message = flagText;
  if (!message) {
    message = outOfBudget
      ? `${label} has hit its budget cap`
      : `${label} is within 10% of budget cap`;
  } else if (outOfBudget) {
    // Column AO words every budget flag as "within 10% of budget cap". When the cap is
    // spent out, say that instead — the rest of AO's text (shortname, end date) carries
    // through untouched. This deliberately says "has hit its budget cap" even with 1% of
    // the cap left rather than quoting the percentage: Meta routinely leaves the last few
    // dollars unspent, and "within 1% of cap" would read as a near miss on a campaign that
    // has already stopped delivering.
    message = message
      .replace('is within 10% of budget cap and ending', 'has hit its budget cap, ending')
      .replace('is within 10% of budget cap', 'has hit its budget cap');
  }

  return {
    campaign: campaign,
    shortname: shortname,
    status: status,
    row: rowNumber,
    severity: severity,
    pctRemaining: pctRemaining,
    emoji: outOfBudget ? ':rotating_light:' : ':warning:',
    message: message,
    detail: buildWatchdogDetail(campaign, status, cost, basis, remaining, pctRemaining, outOfBudget)
  };
}

function buildWatchdogDetail(campaign, status, cost, budget, remaining, pctRemaining, outOfBudget) {
  const parts = [];

  // budget is the spend cap when one is set, otherwise spend-to-date plus whatever
  // is left — the closest thing to a total the campaign has.
  parts.push(budget > 0
    ? `Spent ${watchdogFormatCurrency(cost)} of ${watchdogFormatCurrency(budget)}`
    : `Spent ${watchdogFormatCurrency(cost)}`);

  // Campaigns that are out of budget say so in the headline above; only the ones
  // still spending need their runway spelled out.
  if (!outOfBudget) {
    parts.push(`${watchdogFormatCurrency(remaining)} left (${watchdogFormatPercentage(pctRemaining)})`);
  }

  // Only worth calling out when the campaign is not running normally.
  if (status && status.toUpperCase() !== 'ACTIVE') {
    parts.push(`status: ${status}`);
  }

  return `${parts.join(' • ')}\n\`${campaign}\``;
}

// One section per flagged campaign, already sorted most urgent first. The emoji on
// each line carries the severity, so no headers or group labels are needed.
function buildWatchdogBlocks(alerts) {
  const blocks = alerts.map(buildWatchdogAlertBlock);

  blocks.push({
    "type": "context",
    "elements": [
      {
        "type": "mrkdwn",
        "text": `Campaign budget watchdog :dog2: - ${watchdogTimestamp()}`
      }
    ]
  });

  return blocks;
}

function buildWatchdogAlertBlock(alert) {
  return {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": `${alert.emoji} *${alert.message}*\n${alert.detail}`
    }
  };
}

function postWatchdogToSlack(alerts) {
  const slackApiUrl = 'https://slack.com/api/chat.postMessage';

  // Same script property as the readout bot.
  const scriptProperties = PropertiesService.getScriptProperties();
  const token = scriptProperties.getProperty('SLACK_OAUTH_TOKEN');
  if (!token) {
    console.error('Slack OAuth token not found. Please set SLACK_OAUTH_TOKEN in the script properties.');
    return false;
  }

  const documentTitle = watchdogDocumentTitle();

  let threadTs = null;
  let replyBroadcast = false;
  if (WATCHDOG_SLACK_THREAD_URL) {
    threadTs = watchdogExtractThreadTsFromUrl(WATCHDOG_SLACK_THREAD_URL);
    replyBroadcast = true;
  }

  const criticalCount = alerts.filter(alert => alert.severity === 'critical').length;
  const warningCount = alerts.length - criticalCount;
  // Not shown in-channel — this is the push/sidebar preview, so it names the tracker.
  const summary = `${documentTitle} budget watchdog - ${criticalCount} out of budget, ${warningCount} within 10% of cap`;

  const payload = {
    channel: WATCHDOG_SLACK_CHANNEL_ID,
    text: summary, // Fallback text for notifications and unsupported clients
    blocks: buildWatchdogBlocks(alerts),
    ...(threadTs && { thread_ts: threadTs }),
    ...(threadTs && { reply_broadcast: replyBroadcast })
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(slackApiUrl, options);
    const responseJson = JSON.parse(response.getContentText());
    if (!responseJson.ok) {
      console.error(`Failed to send message to Slack: ${responseJson.error}`);
      return false;
    }
    return true;
  } catch (error) {
    console.error('Error sending message to Slack: ', error);
    return false;
  }
}

/**
 * Creates the daily time-based triggers. Safe to re-run — existing watchdog
 * triggers are cleared first so you never end up with duplicates.
 */
function installWatchdogTriggers() {
  const removed = removeWatchdogTriggers();
  if (removed > 0) {
    console.log(`Removed ${removed} existing watchdog trigger(s).`);
  }

  WATCHDOG_RUN_TIMES.forEach(time => {
    let builder = ScriptApp.newTrigger(WATCHDOG_TRIGGER_HANDLER)
      .timeBased()
      .atHour(time.hour)
      .nearMinute(time.minute)
      .everyDays(1);

    if (WATCHDOG_TIMEZONE) {
      builder = builder.inTimezone(WATCHDOG_TIMEZONE);
    }

    builder.create();
    console.log(`Scheduled daily run near ${watchdogFormatTime(time)}.`);
  });

  console.log(`Installed ${WATCHDOG_RUN_TIMES.length} watchdog trigger(s). Apps Script fires these within ~15 minutes of the requested time.`);
}

/**
 * Deletes every trigger pointing at the watchdog handler. Returns the count removed.
 */
function removeWatchdogTriggers() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === WATCHDOG_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });
  return removed;
}

/**
 * Logs the currently installed watchdog triggers.
 */
function listWatchdogTriggers() {
  const triggers = ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === WATCHDOG_TRIGGER_HANDLER);

  if (triggers.length === 0) {
    console.log('No watchdog triggers installed. Run installWatchdogTriggers().');
    return;
  }

  console.log(`${triggers.length} watchdog trigger(s) installed:`);
  triggers.forEach(trigger => console.log(`  ${trigger.getUniqueId()} (${trigger.getEventType()})`));
}

function watchdogExtractThreadTsFromUrl(url) {
  const matches = url.match(/thread_ts=(\d+\.\d+)/);
  return matches ? matches[1] : null;
}

// Converts a column letter such as 'AE' to its 1-based index.
function watchdogColumnToIndex(letters) {
  let index = 0;
  const upper = letters.toUpperCase();
  for (let i = 0; i < upper.length; i++) {
    index = index * 26 + (upper.charCodeAt(i) - 64);
  }
  return index;
}

// Converts a 1-based column index back to its letter, e.g. 41 -> 'AO'.
function watchdogIndexToColumn(index) {
  let letters = '';
  let remaining = index;
  while (remaining > 0) {
    const modulo = (remaining - 1) % 26;
    letters = String.fromCharCode(65 + modulo) + letters;
    remaining = Math.floor((remaining - modulo) / 26);
  }
  return letters;
}

function watchdogToText(value) {
  if (value === null || value === undefined) return '';
  return value.toString().trim();
}

// Returns null for blanks and non-numeric cells so callers can tell "empty" from zero.
function watchdogToNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : parseFloat(value.toString().replace(/[$,]/g, ''));
  return isNaN(number) ? null : number;
}

function watchdogFormatCurrency(amount) {
  if (amount === null) return 'n/a';
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0
  });
}

function watchdogFormatPercentage(value) {
  const percent = value * 100;
  const digits = percent > 0 && percent < 1 ? 2 : 1;
  return `${percent.toFixed(digits)}%`;
}

function watchdogFormatTime(time) {
  const suffix = time.hour < 12 ? 'AM' : 'PM';
  const hour12 = time.hour % 12 === 0 ? 12 : time.hour % 12;
  const minutes = time.minute < 10 ? `0${time.minute}` : `${time.minute}`;
  return `${hour12}:${minutes} ${suffix}`;
}

function watchdogTimestamp() {
  const timezone = WATCHDOG_TIMEZONE || Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(), timezone, 'MMM d, h:mm a');
}

// Today's date as a plain key. Uses the same timezone as the run schedule so the day
// rolls over at local midnight rather than UTC.
function watchdogToday() {
  const timezone = WATCHDOG_TIMEZONE || Session.getScriptTimeZone();
  return Utilities.formatDate(new Date(), timezone, 'yyyy-MM-dd');
}
