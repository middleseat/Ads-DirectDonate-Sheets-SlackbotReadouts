/**
 * Slack Bot for Google Sheets Readout
 * Version: 3.3.0
 * Author: Ryan Mioduski
 *
 * Important:
 * Before using the bot, you need to configure it with the correct Slack channel ID and
 * the data range from which to fetch data in your Google Sheets document. Optionally,
 * you can also specify a Slack thread URL to direct the message to a specific thread,
 * a notes range for including flags at the top of the readouts, and ranges for copying
 * and pasting values within the sheet as part of the operation.
 *
 * Nothing is posted until you approve it. "Send Readout to Slack" opens a preview of the
 * exact message and flags figures that read as a half-finished data refresh — see
 * analyzeReadout() for what it checks and why.
 *
 * For full documentation, please visit the GitHub repository:
 * https://github.com/ryanmio/SheetsToSlackBot
 */

// Configuration 
const SLACK_CHANNEL_ID = 'U0127C7UF16'; // Update this with your channel ID
const DATA_RANGE_START = 'B35'; // Update this if you want to start from a different cell
const SLACK_THREAD_URL = ''; // Optional: Update this with your thread URL if you want to post to a specific thread
const NOTES_RANGE = 'E43:E'; // Optional: Update this with your notes range
const COPY_RANGE = 'B14:U17'; // Optional: Update this with your copy range
const PASTE_RANGE = 'B26:U29'; // Optional: Update this with your paste range
const SHEET_NAME = 'Readouts'; // The name of the sheet to use for all operations
// Canvas Configuration (optional)
const CANVAS_URL = ''; // Optional: Slack Canvas URL to update
const CANVAS_TITLE = 'Readouts Canvas'; // Optional: for logging/reference
// Preview Configuration
const PREVIEW_BEFORE_SENDING = true; // Show the preview dialog before anything is posted to Slack
const MAX_PLAUSIBLE_ROI = 10; // ROI above this (10 = 1000%) reads as a mid-refresh artifact, not a result
// End Configuration

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Slack Bot')
    .addItem('Send Readout to Slack', 'sendSlackMessage')
    .addToUi();
}

function getNotes() {
  if (!NOTES_RANGE) return []; // Return an empty array if NOTES_RANGE is not configured

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    console.error(`Sheet "${SHEET_NAME}" not found.`);
    return [];
  }
  
  const notesRange = sheet.getRange(NOTES_RANGE);
  const notesValues = notesRange.getValues();
  
  // Regular expression to match emoji patterns like :word:
  const emojiPattern = /^:[a-zA-Z0-9_]+:/;

  // Filter out empty rows, change rows with only "#N/A", and format notes
  const notes = notesValues
    .filter(note => note[0] && typeof note[0] === 'string' && note[0].trim() !== '') // Check if note[0] is a string and not empty
    .map(note => {
      const noteText = note[0].trim();
      // Check if the note is "#N/A"
      if (noteText.toUpperCase() === '#N/A') {
        // Return "Error fetching note" for "#N/A"
        return 'Error fetching note';
      } else if (emojiPattern.test(noteText)) {
        // If it starts with an emoji, use it as is
        return noteText;
      } else {
        // If not, prefix the note with the :warning: emoji
        return `:warning: ${noteText}`;
      }
    });
  
  return notes;
}

function getSheetData() {
    console.log("Fetching sheet data from " + SHEET_NAME);
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(SHEET_NAME);
    if (!sheet) {
      console.error(`Sheet "${SHEET_NAME}" not found.`);
      return [];
    }
  
    // Dynamically calculate the range based on DATA_RANGE_START
    const lastRow = sheet.getLastRow();
    const rangeStartColumn = DATA_RANGE_START.charAt(0);
    const rangeEndColumn = String.fromCharCode(rangeStartColumn.charCodeAt(0) + 1);
    const range = sheet.getRange(`${DATA_RANGE_START}:${rangeEndColumn}${lastRow}`);
    console.log(`Defined range: ${range.getA1Notation()}`);
  
    const values = range.getValues();
    
    let filteredValues = [];
    let currentSection = [];
    let isCurrentSectionValid = false;
  
    values.forEach((row, index) => {
      // Check if row is the start of a new section or the end of the data
      if (row[0].startsWith('*') || index === values.length - 1) {
        // At the start of a new section, decide if the previous section should be added
        if (currentSection.length > 0 && isCurrentSectionValid) {
          // Add the previous section if it was valid
          filteredValues = filteredValues.concat(currentSection);
        }
        // Reset for the new section
        currentSection = [];
        isCurrentSectionValid = false; // Reset flag
      }
  
      // Add row to the current section
      currentSection.push(row);
  
      // Check if the current row has meaningful data (not blank and not zero)
      if (row[1] !== '' && row[1] !== 0 && row[1] !== '0.00%' && row[1] !== null) {
        isCurrentSectionValid = true;
      }
  
      // Special case for the last row of the data
      if (index === values.length - 1 && isCurrentSectionValid) {
        filteredValues = filteredValues.concat(currentSection);
      }
    });
  
    console.log(`Data fetched from sheet: ${JSON.stringify(filteredValues)}`);
    return filteredValues;
  }

  // Helper function to format numbers with commas
  function formatNumber(number) {
    return parseInt(number, 10).toLocaleString('en-US');
  }

  // Helper function to format currency
  function formatCurrency(amount) {
    return parseFloat(amount).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  // Helper function to format percentage
  function formatPercentage(value) {
    return (parseFloat(value) * 100).toFixed(2) + '%';
  }

// Build Markdown for Slack Canvas based on existing notes/data formatting
function buildCanvasMarkdown(notes, data, documentTitle, formattedDate) {
  const now = new Date();
  const dateTimeStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a');

  let markdown = `# ${documentTitle} Readout – ${formattedDate}\n\n`;

  if (notes && notes.length > 0) {
    markdown += '## Notes\n\n';
    notes.forEach(n => {
      markdown += `* ${n}\n`;
    });
    markdown += '\n';
  }

  let sinceLastUpdateFlag = false;
  let currentCampaign = '';
  let hasAnyCampaign = false;

  data.forEach((row, index) => {
    const label = (row[0] || '').toString();
    let value = row[1];

    // New campaign header
    if (label.startsWith('*') && label.endsWith('*')) {
      if (currentCampaign !== '') {
        markdown += '\n';
      }
      currentCampaign = label.slice(1, -1);
      markdown += `## ${currentCampaign}\n`;
      hasAnyCampaign = true;
      sinceLastUpdateFlag = false;
      return;
    }

    // Format value
    let formattedValue = value;
    if (label.includes('Spent') || label.includes('Raised')) {
      formattedValue = formatCurrency(value);
    } else if (label.includes('Donations')) {
      formattedValue = formatNumber(value);
    } else if (label.includes('ROI')) {
      formattedValue = formatPercentage(value);
    }

    if (label.startsWith('> *Since Last Update*')) {
      markdown += `\n> *Since Last Update*\n`;
      sinceLastUpdateFlag = true;
    } else if (sinceLastUpdateFlag) {
      const rowData = label.startsWith('>') ? label.slice(1).trim() : label.trim();
      markdown += `> ${rowData}: ${formattedValue}\n`;
    } else if (label.trim() !== '') {
      markdown += `- ${label.trim()}: ${formattedValue}\n`;
    }

    if (index === data.length - 1) {
      markdown += '\n';
    }
  });

  if (!hasAnyCampaign) {
    markdown += '_No campaign data available._\n\n';
  }

  markdown += `\n_Last updated: ${dateTimeStr}_`;
  return markdown;
}

function formatDataForSlack(data) {
  const blocks = []; // Initialize an array to hold all blocks
  let currentCampaignText = "";
  let sinceLastUpdateFlag = false; // Flag to track the "Since Last Update" section

  data.forEach((row, index) => {
    // Check if it's a campaign name
    if (row[0].startsWith('*') && row[0].endsWith('*')) {
      // If there's current campaign text, push it as a block before starting a new one
      if (currentCampaignText !== "") {
        blocks.push({
          "type": "section",
          "text": {
            "type": "mrkdwn",
            "text": currentCampaignText.trim()
          }
        });
        // Add a divider block here
        blocks.push({
          "type": "divider"
        });
        currentCampaignText = ""; // Reset the campaign text for the next campaign
      }
      // Start the new campaign text with the campaign name (removing asterisks)
      currentCampaignText += `*${row[0].slice(1, -1)}*\n`;
      sinceLastUpdateFlag = false; // Reset the flag for the new campaign
    } else {
      // For data rows, append them to the current campaign's text with appropriate formatting
      let formattedValue = row[1];
      if (row[0].includes("Spent") || row[0].includes("Raised")) {
        formattedValue = formatCurrency(row[1]);
      } else if (row[0].includes("Donations")) {
        formattedValue = formatNumber(row[1]);
      } else if (row[0].includes("ROI")) {
        formattedValue = formatPercentage(row[1]);
      }

      // Check for "Since Last Update" and add a line break before it
      if (row[0].startsWith('> *Since Last Update*')) {
        // Format "Since Last Update" as a quote and add it programmatically
        currentCampaignText += `\n> *Since Last Update*\n`;
        sinceLastUpdateFlag = true;
      } else if (sinceLastUpdateFlag) {
        // If the row is part of the "Since Last Update" section, format as a quote
        let rowData = row[0].startsWith('>') ? row[0].slice(1).trim() : row[0].trim();
        currentCampaignText += `> ${rowData}: ${formattedValue}\n`;
      } else {
        // For rows not part of the "Since Last Update" section, add them normally
        currentCampaignText += `${row[0].trim()}: ${formattedValue}\n`;
      }
    }

    // Ensure the last campaign's text is also added as a block
    if (index === data.length - 1 && currentCampaignText !== "") {
      blocks.push({
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": currentCampaignText.trim()
        }
      });
    }
  });

  return blocks;
}

// Extract Canvas File ID (starts with F...) from Slack docs URL
function extractCanvasIdFromUrl(url) {
  if (!url) return null;
  try {
    const match = url.match(/\/docs\/[^/]+\/(F[0-9A-Z]+)/);
    return match ? match[1] : null;
  } catch (e) {
    console.log('Failed to extract canvas id from URL: ' + e);
    return null;
  }
}

// Update an existing Slack Canvas by ID with markdown content
function updateExistingCanvasById(canvasId, markdown, token) {
  if (!canvasId) {
    console.log('No canvasId provided; skipping canvas update.');
    return false;
  }
  const payload = {
    canvas_id: canvasId,
    changes: [
      {
        operation: 'replace',
        document_content: {
          type: 'markdown',
          markdown: markdown
        }
      }
    ]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch('https://slack.com/api/canvases.edit', options);
    const result = JSON.parse(response.getContentText());
    console.log('canvases.edit response: ' + JSON.stringify(result));
    return !!result.ok;
  } catch (e) {
    console.log('Exception calling canvases.edit: ' + e.toString());
    return false;
  }
}

// Fetch permalink for a Canvas (file)
function getCanvasPermalink(canvasId, token) {
  try {
    const options = {
      method: 'get',
      contentType: 'application/x-www-form-urlencoded',
      headers: {
        'Authorization': 'Bearer ' + token
      },
      muteHttpExceptions: true
    };
    const response = UrlFetchApp.fetch('https://slack.com/api/files.info?file=' + encodeURIComponent(canvasId), options);
    const result = JSON.parse(response.getContentText());
    if (result.ok && result.file && result.file.permalink) {
      return result.file.permalink;
    }
    console.log('files.info did not return permalink: ' + JSON.stringify(result));
    return null;
  } catch (e) {
    console.log('Exception calling files.info: ' + e.toString());
    return null;
  }
}

// Update Canvas (if configured) and return permalink when available
function updateCanvasIfConfigured(notes, data, documentTitle, formattedDate) {
  if (!CANVAS_URL) {
    return { attempted: false, success: false, permalink: null };
  }
  const token = PropertiesService.getScriptProperties().getProperty('SLACK_OAUTH_TOKEN');
  const canvasId = extractCanvasIdFromUrl(CANVAS_URL);
  if (!canvasId) {
    console.log('Could not extract Canvas ID from CANVAS_URL.');
    return { attempted: true, success: false, permalink: null };
  }
  const markdown = buildCanvasMarkdown(notes, data, documentTitle, formattedDate);
  const updated = updateExistingCanvasById(canvasId, markdown, token);
  const permalink = updated ? getCanvasPermalink(canvasId, token) : null;
  return { attempted: true, success: updated, permalink: permalink };
}

// ---------- Preview and mid-refresh checks ----------

const READOUT_SPREADSHEET_ERRORS = /^#(N\/A|REF!|VALUE!|DIV\/0!|ERROR!|NAME\?|NUM!|NULL!)/i;
const READOUT_CUMULATIVE_METRICS = ['spent', 'raised', 'donations']; // Only ever go up, which is what makes the checks below possible

/**
 * Reads the rows from getSheetData() into campaigns and flags anything that reads as a
 * half-finished data refresh rather than a real number.
 *
 * Every figure in the readout is cumulative, and each "Since Last Update" line is this
 * pull minus the snapshot sitting in PASTE_RANGE. So while a connector is still writing,
 * the current pull comes back partial and the deltas go *negative* — spend keeps climbing
 * while raised and donations fall off a cliff and ROI blows past any real number. The
 * figures still look precise, which is exactly why they get sent by mistake.
 *
 * Returns { campaigns, issues, errorCount, warningCount }. Errors are impossible values
 * that gate the send button; warnings are worth a look but do not block.
 */
function analyzeReadout(notes, data) {
  const campaigns = [];
  const issues = [];

  function flag(severity, text, row) {
    const issue = { severity: severity, text: text };
    issues.push(issue);
    if (row) row.issues.push(issue);
  }

  let current = null;
  let inSinceLastUpdate = false;

  (data || []).forEach(rawRow => {
    const label = readoutToText(rawRow[0]);

    // Campaign header, e.g. *Live Campaigns Total*
    if (label.length > 1 && label.charAt(0) === '*' && label.slice(-1) === '*') {
      current = {
        name: label.slice(1, -1),
        isTotal: /total/i.test(label),
        rows: [],
        totals: {},
        deltas: {}
      };
      campaigns.push(current);
      inSinceLastUpdate = false;
      return;
    }

    if (!current || label === '') return; // Stray rows before the first header have nothing to belong to

    if (/Since Last Update/i.test(label)) {
      inSinceLastUpdate = true;
      current.rows.push({ kind: 'deltaHeader', label: 'Since Last Update', issues: [] });
      return;
    }

    const metric = readoutMetric(label);
    const row = {
      kind: inSinceLastUpdate ? 'delta' : 'total',
      label: label.replace(/^>\s*/, '').trim(), // Delta rows carry a leading '>' for Slack's quote formatting
      metric: metric,
      raw: rawRow[1],
      number: readoutToNumber(rawRow[1]),
      formatted: readoutFormatValue(label, rawRow[1]), // Formatted the same way Slack will show it, NaN and all
      issues: []
    };

    current.rows.push(row);
    if (metric) {
      const bucket = row.kind === 'delta' ? current.deltas : current.totals;
      bucket[metric] = row;
    }
  });

  if (campaigns.length === 0) {
    flag('error', `No campaign data found from ${DATA_RANGE_START} on the "${SHEET_NAME}" tab. Sending now would post an empty readout.`);
  }

  campaigns.forEach(campaign => {
    const name = campaign.name;

    campaign.rows.forEach(row => {
      if (row.kind === 'deltaHeader') return;
      const rawText = readoutToText(row.raw);
      const where = row.kind === 'delta' ? `Since Last Update ${row.label}` : row.label;

      // A cell that has not calculated. Slack would print "$NaN" and nobody would know why.
      if (READOUT_SPREADSHEET_ERRORS.test(rawText)) {
        flag('error', `${name} — ${where} is ${rawText}. The sheet has not finished calculating.`, row);
      } else if (row.metric && row.number === null) {
        flag('error', `${name} — ${where} is ${rawText === '' ? 'blank' : `"${rawText}"`} instead of a number.`, row);
      }
    });

    READOUT_CUMULATIVE_METRICS.forEach(metric => {
      const total = campaign.totals[metric];
      const delta = campaign.deltas[metric];

      // Spend, money raised and donation counts are running totals. They cannot be negative.
      if (total && total.number !== null && total.number < 0) {
        flag('error', `${name} — ${total.label} is ${total.formatted}. A running total cannot be negative.`, total);
      }

      // The signature of a mid-refresh send: this pull came back lower than the last snapshot.
      if (delta && delta.number !== null && delta.number < 0) {
        flag('error', `${name} — Since Last Update ${delta.label} is ${delta.formatted}. Totals only go up, so this pull came back lower than the last snapshot — the data is still refreshing.`, delta);
      }

      // delta = current - previous, and previous was never negative, so delta > total is impossible.
      if (delta && total && delta.number !== null && total.number !== null && delta.number > total.number + 0.01) {
        flag('error', `${name} — Since Last Update ${delta.label} (${delta.formatted}) is larger than the ${total.label} it came out of (${total.formatted}).`, delta);
      }
    });

    // Money without donations, or donations without money, means one of the two has not landed yet.
    const raised = campaign.totals['raised'];
    const donations = campaign.totals['donations'];
    if (raised && donations && raised.number !== null && donations.number !== null) {
      if (raised.number > 0 && donations.number === 0) {
        flag('error', `${name} — ${raised.label} is ${raised.formatted} but ${donations.label} is 0.`, donations);
      } else if (donations.number > 0 && raised.number === 0) {
        flag('error', `${name} — ${donations.label} is ${donations.formatted} but ${raised.label} is ${raised.formatted}.`, raised);
      }
    }

    // Spend is usually the first thing to load, so zero spend against real results is a partial pull.
    const spent = campaign.totals['spent'];
    if (spent && spent.number === 0 && ((raised && raised.number > 0) || (donations && donations.number > 0))) {
      flag('warning', `${name} — ${spent.label} is ${spent.formatted} while the campaign reports results.`, spent);
    }

    // ROI is derived, so it is a symptom rather than a cause — but a wild one is worth seeing.
    ['totals', 'deltas'].forEach(bucket => {
      const roi = campaign[bucket]['roi'];
      if (!roi || roi.number === null) return;
      const where = bucket === 'deltas' ? `Since Last Update ${roi.label}` : roi.label;
      if (roi.number < 0) {
        flag('warning', `${name} — ${where} is ${roi.formatted}.`, roi);
      } else if (roi.number > MAX_PLAUSIBLE_ROI) {
        flag('warning', `${name} — ${where} is ${roi.formatted}, past anything this tracker reports.`, roi);
      }
    });
  });

  // Every delta at exactly zero means nothing has moved since the last snapshot, which
  // usually means the readout already went out and the baseline was already reset.
  const deltaNumbers = [];
  campaigns.forEach(campaign => {
    READOUT_CUMULATIVE_METRICS.forEach(metric => {
      const delta = campaign.deltas[metric];
      if (delta && delta.number !== null) deltaNumbers.push(delta.number);
    });
  });
  if (deltaNumbers.length > 0 && deltaNumbers.every(number => number === 0)) {
    flag('warning', 'Nothing has changed since the last update — every "Since Last Update" figure is zero. Has this readout already been sent today?');
  }

  // getNotes() turns an uncalculated note into this, which is the same story as a #N/A cell.
  (notes || []).forEach(note => {
    if (note.indexOf('Error fetching note') !== -1) {
      flag('warning', `A note in ${NOTES_RANGE} has not calculated and would post as "${note}".`);
    }
  });

  return {
    campaigns: campaigns,
    issues: issues,
    errorCount: issues.filter(issue => issue.severity === 'error').length,
    warningCount: issues.filter(issue => issue.severity === 'warning').length
  };
}

// Which metric a row reports, matched in the same order the Slack formatting matches so
// the preview and the message can never disagree about a label.
function readoutMetric(label) {
  if (label.includes('Spent')) return 'spent';
  if (label.includes('Raised')) return 'raised';
  if (label.includes('Donations')) return 'donations';
  if (label.includes('ROI')) return 'roi';
  return null;
}

// Mirrors formatDataForSlack() exactly, including what it does to a cell that has not
// calculated — the preview is only worth having if it shows what Slack would show.
function readoutFormatValue(label, value) {
  if (label.includes('Spent') || label.includes('Raised')) return formatCurrency(value);
  if (label.includes('Donations')) return formatNumber(value);
  if (label.includes('ROI')) return formatPercentage(value);
  return readoutToText(value);
}

function readoutToText(value) {
  if (value === null || value === undefined) return '';
  return value.toString().trim();
}

// Returns null for blanks and non-numeric cells so callers can tell "empty" from zero.
function readoutToNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : parseFloat(value.toString().replace(/[$,%]/g, ''));
  return isNaN(number) ? null : number;
}

function readoutEscapeHtml(text) {
  return readoutToText(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function readoutCount(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// Whether there is a spreadsheet UI to open a dialog in. Time-based triggers and some
// editor runs have none, and asking for one there throws.
function readoutCanShowUi() {
  try {
    SpreadsheetApp.getUi();
    return true;
  } catch (error) {
    console.log(`No spreadsheet UI available (${error}).`);
    return false;
  }
}

/**
 * Opens the preview dialog. The rows are handed to the dialog and handed back on Send, so
 * the message that goes out is built from the numbers that were on screen — a refresh
 * landing between the preview and the click cannot change what was approved.
 */
function showReadoutPreview(notes, data) {
  const analysis = analyzeReadout(notes, data);
  console.log(`Preview: ${analysis.campaigns.length} campaign(s), ${analysis.errorCount} error(s), ${analysis.warningCount} warning(s)`);
  analysis.issues.forEach(issue => console.log(`[${issue.severity}] ${issue.text}`));

  const html = HtmlService.createHtmlOutput(buildPreviewHtml(notes, data, analysis))
    .setWidth(680)
    .setHeight(660); // Tall enough for a flagged readout; the campaign list scrolls past that
  SpreadsheetApp.getUi().showModalDialog(html, 'Check the readout before sending');
}

function buildPreviewHtml(notes, data, analysis) {
  const esc = readoutEscapeHtml;
  const blocked = analysis.errorCount > 0;
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const today = new Date();
  const headline = `${spreadsheet.getName()} Readout - ${today.toLocaleString('default', { month: 'short' })} ${today.getDate()}`;

  let banner;
  if (blocked) {
    banner = `<div class="banner bad"><b>${esc(readoutCount(analysis.errorCount, 'figure'))} can't be right — the data looks like it is still refreshing.</b>
      <span>Let the sheet finish calculating, close this, and send again.</span></div>`;
  } else if (analysis.warningCount > 0) {
    banner = `<div class="banner warn"><b>${esc(readoutCount(analysis.warningCount, 'thing'))} worth a look before this goes out.</b>
      <span>Nothing impossible, so send when you are happy with it.</span></div>`;
  } else {
    banner = `<div class="banner ok"><b>The numbers hold up.</b>
      <span>Deltas are positive and every figure calculated.</span></div>`;
  }

  const issueList = analysis.issues.length === 0 ? '' : `<ul class="issues">${analysis.issues
    .map(issue => `<li class="${issue.severity}"><span class="dot"></span>${esc(issue.text)}</li>`)
    .join('')}</ul>`;

  const notesHtml = (notes || []).length === 0 ? '' :
    `<div class="notes">${notes.map(note => `<div>${esc(note)}</div>`).join('')}</div>`;

  const campaignsHtml = analysis.campaigns.map(campaign => {
    const rows = campaign.rows.map(row => {
      if (row.kind === 'deltaHeader') return '<div class="deltaHead">Since Last Update</div>';
      const severity = row.issues.some(issue => issue.severity === 'error') ? 'bad'
        : (row.issues.length > 0 ? 'warn' : '');
      return `<div class="row ${row.kind === 'delta' ? 'delta' : ''}">
        <span class="label">${esc(row.label)}</span>
        <span class="value ${severity}">${esc(row.formatted)}</span>
      </div>`;
    }).join('');
    return `<div class="campaign${campaign.isTotal ? ' isTotal' : ''}">
      <div class="name">${esc(campaign.name)}</div>${rows}</div>`;
  }).join('') || '<div class="empty">No campaign data to send.</div>';

  const destination = [
    `channel <code>${esc(SLACK_CHANNEL_ID)}</code>`,
    SLACK_THREAD_URL ? 'in the configured thread' : '',
    CANVAS_URL ? `and updates <b>${esc(CANVAS_TITLE || 'the canvas')}</b>` : ''
  ].filter(Boolean).join(' ');

  // Shown on the success screen, so it says what actually happened rather than "Complete!".
  // Set as textContent on the client, which is why it carries no markup.
  const sentNote = [
    `${readoutCount(analysis.campaigns.length, 'campaign')} posted to ${SLACK_CHANNEL_ID}${SLACK_THREAD_URL ? ' in the configured thread' : ''}.`,
    CANVAS_URL ? `${CANVAS_TITLE || 'The canvas'} updated.` : '',
    COPY_RANGE && PASTE_RANGE ? `${PASTE_RANGE} now holds the baseline for the next readout.` : ''
  ].filter(Boolean).join(' ');

  // Escaped so a campaign name containing markup cannot break out of the script tag.
  const payloadLiteral = JSON.stringify(JSON.stringify({ notes: notes, data: data }))
    .replace(/</g, '\\u003c');

  return `
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         font-size: 13px; color: #202124; margin: 0; padding: 16px 18px 12px; }
  .banner { border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.45; }
  .banner span { display: block; opacity: 0.85; }
  .banner.bad { background: #fce8e6; color: #a50e0e; }
  .banner.warn { background: #fef7e0; color: #8a5300; }
  .banner.ok { background: #e6f4ea; color: #14652c; }
  ul.issues { list-style: none; margin: 0 0 14px; padding: 0; }
  ul.issues li { position: relative; padding: 4px 0 4px 18px; line-height: 1.45; }
  ul.issues .dot { position: absolute; left: 2px; top: 9px; width: 7px; height: 7px; border-radius: 50%; }
  ul.issues li.error .dot { background: #d93025; }
  ul.issues li.warning .dot { background: #f9ab00; }
  .headline { font-weight: 600; font-size: 14px; margin: 0 0 8px; }
  .sheet { border: 1px solid #dadce0; border-radius: 8px; padding: 12px 14px;
           max-height: 300px; overflow-y: auto; background: #fff; }
  .notes { border-left: 3px solid #f9ab00; padding-left: 10px; margin-bottom: 12px; color: #5f6368; }
  .notes div { padding: 1px 0; }
  .campaign { margin-bottom: 14px; }
  .campaign.isTotal { background: #f1f3f4; border-radius: 6px; padding: 8px 10px; }
  .campaign .name { font-weight: 600; margin-bottom: 4px; }
  .row { display: flex; justify-content: space-between; gap: 16px; padding: 1px 0; }
  .row.delta { border-left: 3px solid #dadce0; padding-left: 9px; margin-left: 1px; }
  .deltaHead { font-weight: 600; color: #5f6368; margin: 6px 0 2px; padding-left: 12px; }
  .label { color: #5f6368; }
  .value { font-variant-numeric: tabular-nums; white-space: nowrap; }
  .value.bad { color: #d93025; font-weight: 600; background: #fce8e6; border-radius: 3px; padding: 0 4px; }
  .value.warn { color: #8a5300; font-weight: 600; background: #fef7e0; border-radius: 3px; padding: 0 4px; }
  .empty { color: #d93025; }
  .destination { color: #5f6368; margin: 12px 0 0; }
  .override { display: ${blocked ? 'flex' : 'none'}; align-items: center; gap: 7px;
              margin-top: 12px; color: #a50e0e; }
  .actions { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-top: 14px; }
  button { font: inherit; border-radius: 6px; padding: 8px 16px; border: 1px solid #dadce0;
           background: #fff; color: #1a73e8; cursor: pointer; }
  button.primary { background: #1a73e8; border-color: #1a73e8; color: #fff; }
  button.primary.danger { background: #d93025; border-color: #d93025; }
  button[disabled] { opacity: 0.45; cursor: not-allowed; }
  #status { margin-right: auto; color: #5f6368; }
  #status.bad { color: #d93025; }

  /* Success screen. Everything here animates transform, opacity or a dash offset only,
     so it stays on the compositor and costs nothing to run. */
  .done { position: fixed; top: 0; right: 0; bottom: 0; left: 0; background: #fff; padding: 24px;
          display: none; flex-direction: column; align-items: center; justify-content: center;
          gap: 6px; text-align: center; }
  .done.show { display: flex; animation: fadeIn 0.2s ease-out; }
  .mark { position: relative; width: 62px; height: 62px; margin-bottom: 10px; }
  .mark svg { width: 62px; height: 62px; display: block; }
  .mark .ring, .mark .tick { fill: none; stroke: #1e8e3e; stroke-linecap: round; stroke-linejoin: round; }
  .mark .ring { stroke-width: 2; stroke-dasharray: 151; stroke-dashoffset: 151; animation: draw 0.45s ease-out forwards; }
  .mark .tick { stroke-width: 3.5; stroke-dasharray: 40; stroke-dashoffset: 40; animation: draw 0.3s 0.3s ease-out forwards; }
  .mark .pulse { position: absolute; top: 0; right: 0; bottom: 0; left: 0; border-radius: 50%;
                 border: 2px solid #1e8e3e; opacity: 0; animation: pulse 0.9s 0.25s ease-out forwards; }
  .done.problem .ring, .done.problem .tick { stroke: #f9ab00; }
  .done.problem .pulse { border-color: #f9ab00; }
  #doneTitle { font-size: 17px; font-weight: 600; }
  #doneNote { color: #5f6368; max-width: 430px; line-height: 1.5; }
  #done button { margin-top: 16px; }
  #confetti { position: absolute; top: 0; right: 0; bottom: 0; left: 0; overflow: hidden; pointer-events: none; }
  #confetti i { position: absolute; top: 44%; left: 50%; width: 6px; height: 10px; border-radius: 1px; opacity: 0;
                animation-name: confetti; animation-timing-function: ease-out; animation-fill-mode: forwards; }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  @keyframes pulse { from { transform: scale(1); opacity: 0.5; } to { transform: scale(2); opacity: 0; } }
  @keyframes fadeIn { from { opacity: 0; } }
  @keyframes confetti {
    0% { opacity: 1; transform: translate3d(0, 0, 0) rotate(0deg); }
    100% { opacity: 0; transform: translate3d(var(--tx), var(--ty), 0) rotate(var(--rot)); }
  }
  /* Respect the machine's own setting rather than deciding for it. */
  @media (prefers-reduced-motion: reduce) {
    .done.show, .mark .ring, .mark .tick, #confetti i { animation: none; }
    .mark .ring, .mark .tick { stroke-dashoffset: 0; }
    .mark .pulse { display: none; }
  }
</style>

${banner}
${issueList}
<div class="headline">${esc(headline)}</div>
<div class="sheet">${notesHtml}${campaignsHtml}</div>
<div class="destination">Posts to ${destination}, then copies ${esc(COPY_RANGE)} into ${esc(PASTE_RANGE)} as the new baseline.</div>

<label class="override"><input type="checkbox" id="override"> I checked the sheet — send it anyway</label>

<div class="actions">
  <span id="status"></span>
  <button id="cancel" type="button">Cancel</button>
  <button id="send" type="button" class="primary${blocked ? ' danger' : ''}"${blocked ? ' disabled' : ''}>${blocked ? 'Send anyway' : 'Send to Slack'}</button>
</div>

<div id="done" class="done">
  <div id="confetti"></div>
  <div class="mark">
    <svg viewBox="0 0 52 52" aria-hidden="true">
      <circle class="ring" cx="26" cy="26" r="24"></circle>
      <path class="tick" d="M15.5 26.5 L22.5 33.5 L37 19"></path>
    </svg>
    <span class="pulse"></span>
  </div>
  <div id="doneTitle"></div>
  <div id="doneNote"></div>
  <button id="close" type="button" class="primary">Close</button>
</div>

<script>
  var PAYLOAD_JSON = ${payloadLiteral};
  var SENT_NOTE = ${JSON.stringify(sentNote)};

  var send = document.getElementById('send');
  var override = document.getElementById('override');
  var statusEl = document.getElementById('status'); // Not "status" — that name is taken by window.status
  var done = document.getElementById('done');

  document.getElementById('cancel').onclick = function () {
    google.script.host.close();
  };
  document.getElementById('close').onclick = function () {
    google.script.host.close();
  };

  override.onchange = function () {
    send.disabled = !override.checked;
  };

  send.onclick = function () {
    send.disabled = true;
    override.disabled = true;
    statusEl.className = '';
    statusEl.textContent = 'Sending…';
    google.script.run
      .withSuccessHandler(function (result) {
        if (result.ok) {
          finish('Readout sent', SENT_NOTE, false);
        } else if (result.slackOk) {
          // The message is already in the channel. Leaving Send enabled here would let a
          // second click post the whole readout twice, so this ends in the panel too.
          finish('Sent, but the baseline did not reset', result.message, true);
        } else {
          statusEl.className = 'bad';
          statusEl.textContent = result.message;
          send.disabled = false;
          override.disabled = false;
        }
      })
      .withFailureHandler(function (error) {
        statusEl.className = 'bad';
        statusEl.textContent = 'Nothing was sent: ' + error.message;
        send.disabled = false;
        override.disabled = false;
      })
      .sendReadoutFromPreview(PAYLOAD_JSON);
  };

  // Takes over the dialog with the outcome. A clean send closes itself; anything the
  // sender needs to act on waits for them to dismiss it.
  function finish(title, note, problem) {
    document.getElementById('doneTitle').textContent = title;
    document.getElementById('doneNote').textContent = note;
    done.className = problem ? 'done show problem' : 'done show';

    if (problem) return;
    var celebrating = !prefersReducedMotion();
    if (celebrating) popConfetti();
    setTimeout(google.script.host.close, celebrating ? 2600 : 2100);
  }

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // A single burst from behind the check mark: 26 nodes, one transform each, gone in under
  // two seconds. No canvas, no library, nothing left running behind the dialog.
  function popConfetti() {
    var colors = ['#1a73e8', '#1e8e3e', '#f9ab00', '#d93025', '#a142f4'];
    var layer = document.getElementById('confetti');
    for (var i = 0; i < 26; i++) {
      var piece = document.createElement('i');
      var angle = (-165 + Math.random() * 150) * Math.PI / 180; // Fan upwards and out
      var distance = 90 + Math.random() * 140;
      piece.style.background = colors[i % colors.length];
      piece.style.setProperty('--tx', Math.round(Math.cos(angle) * distance) + 'px');
      piece.style.setProperty('--ty', Math.round(Math.sin(angle) * distance + 80) + 'px'); // Plus a little gravity
      piece.style.setProperty('--rot', Math.round(-540 + Math.random() * 1080) + 'deg');
      piece.style.animationDuration = (1 + Math.random() * 0.5).toFixed(2) + 's';
      piece.style.animationDelay = (Math.random() * 0.12).toFixed(2) + 's';
      layer.appendChild(piece);
    }
    setTimeout(function () { layer.innerHTML = ''; }, 1900);
  }
</script>`;
}

/**
 * The preview dialog's Send button. Posts the rows the preview was built from instead of
 * re-reading the sheet, so what was approved on screen is what goes out.
 */
function sendReadoutFromPreview(payloadJson) {
  const payload = JSON.parse(payloadJson);
  const result = postReadout(payload.notes || [], payload.data || []);
  console.log(`Send from preview finished: ${result.message}`);
  return result;
}

// ---------- Sending ----------

/**
 * Menu entry point. Opens the preview and posts nothing until it is approved. Sends
 * straight away when PREVIEW_BEFORE_SENDING is off or there is no UI to show a dialog in.
 */
function sendSlackMessage() {
  console.log("Preparing to send Slack message");
  const notes = getNotes(); // Fetch notes
  const data = getSheetData();

  if (PREVIEW_BEFORE_SENDING && readoutCanShowUi()) {
    showReadoutPreview(notes, data);
    return;
  }

  console.log('Preview skipped — posting directly.');
  const result = postReadout(notes, data);
  if (readoutCanShowUi()) {
    SpreadsheetApp.getUi().alert(result.message);
  }
}

/**
 * Builds the message from the given rows, posts it, updates the canvas and resets the
 * baseline. Shows no UI of its own so it can run behind the preview dialog or a trigger.
 */
function postReadout(notes, data) {
  const campaignBlocks = formatDataForSlack(data); // Get the blocks for each campaign

  const slackApiUrl = 'https://slack.com/api/chat.postMessage';

  // Use the Properties Service to securely store and access the OAuth token
  const scriptProperties = PropertiesService.getScriptProperties();
  const token = scriptProperties.getProperty('SLACK_OAUTH_TOKEN'); 
  console.log("SLACK_OAUTH_TOKEN retrieved successfully");

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const documentTitle = spreadsheet.getName(); // Get the document title
  const sheetUrl = spreadsheet.getUrl(); // Get the URL of the active spreadsheet

  // Get the email address of the person running the script
  const userEmail = Session.getActiveUser().getEmail();

  // Get today's date and format it
  const today = new Date();
  const month = today.toLocaleString('default', { month: 'short' }); // 'Feb'
  const day = today.getDate(); // 20
  const formattedDate = `${month} ${day}`; // 'Feb 20'

  // Extract the thread_ts from the URL if provided
  let threadTs = null;
  let replyBroadcast = false; // Default to not broadcasting
  if (SLACK_THREAD_URL) {
    threadTs = extractThreadTsFromUrl(SLACK_THREAD_URL);
    replyBroadcast = true; // Set to true to broadcast the reply to the channel
  }

  // Construct the payload with Block Kit blocks
  let payload = {
    channel: SLACK_CHANNEL_ID,
    blocks: [
      {
        "type": "header",
        "text": {
          "type": "plain_text",
          "text": `${documentTitle} Readout - ${formattedDate}`,
          "emoji": true
        }
      },
      // If there are notes, add them as a section block at the top
      ...(notes.length > 0 ? [{
        "type": "section",
        "text": {
          "type": "mrkdwn",
          "text": notes.join('\n') // Join all notes with a newline
        }
      }] : []),
      ...campaignBlocks, // Spread the campaign blocks here
      {
        "type": "actions",
        "elements": [
          {
            "type": "button",
            "text": {
              "type": "plain_text",
              "text": "Open Sheet",
              "emoji": true
            },
            "url": sheetUrl,
            "action_id": "button-action"
          }
        ]
      },
      {
        "type": "context",
        "elements": [
          {
            "type": "mrkdwn",
            "text": `Message sent by: ${userEmail}`
          }
        ]
      }
    ],
    ...(threadTs && { thread_ts: threadTs }), // Include the thread_ts in the payload if it exists
    ...(threadTs && { reply_broadcast: replyBroadcast }) // Include reply_broadcast if thread_ts is present
  };
  console.log(`Payload prepared: ${JSON.stringify(payload)}`);

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    payload: JSON.stringify(payload)
  };
  console.log("Options for UrlFetchApp prepared");

  // Sending the message to Slack
  console.log("Sending message to Slack");
  let slackMessageSuccess = true;
  try {
    const response = UrlFetchApp.fetch(slackApiUrl, options);
    const responseJson = JSON.parse(response.getContentText());
    if (!responseJson.ok) {
      console.error(`Failed to send message to Slack: ${responseJson.error}`);
      slackMessageSuccess = false;
    }
  } catch (error) {
    // The preview dialog reports what comes back from here, so a network failure has to
    // return like any other failure rather than throwing past the caller.
    console.error('Error sending message to Slack: ', error);
    slackMessageSuccess = false;
  }

  // Update Slack Canvas after attempting to send the channel message (non-blocking)
  try {
    updateCanvasIfConfigured(notes, data, documentTitle, formattedDate);
  } catch (e) {
    console.log('Canvas update threw (ignored): ' + e.toString());
  }

  // Perform copy-paste operation only if the Slack message was successfully sent
  let copyPasteSuccess = true; // Assume success unless proven otherwise
  if (slackMessageSuccess) {
    copyPasteSuccess = copyPasteValues();
  } else {
    console.log("Skipping copy-paste operation due to Slack message failure.");
  }

  // Report the outcome back to whoever called — the preview dialog shows this message in
  // its footer, a direct run puts it in an alert.
  let message;
  if (slackMessageSuccess && copyPasteSuccess) {
    message = 'Readout Complete!';
  } else if (!slackMessageSuccess) {
    message = 'Failed to send message to Slack. Please check the logs for more details.';
  } else {
    message = 'Readout sent to Slack, but there was an error with the copy-paste operation. Please check the logs for more details.';
  }

  return { ok: slackMessageSuccess && copyPasteSuccess, slackOk: slackMessageSuccess, copyOk: copyPasteSuccess, message: message };
}

function extractThreadTsFromUrl(url) {
  const matches = url.match(/thread_ts=(\d+\.\d+)/);
  return matches ? matches[1] : null;
}

function copyPasteValues() {
  if (!COPY_RANGE || !PASTE_RANGE) {
    console.log("Copy-Paste ranges are not configured. Skipping this step.");
    return true; // Return true since this isn't an error, just a skipped operation
  }

  try {
    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = spreadsheet.getSheetByName(SHEET_NAME);
    if (!sheet) {
      console.error(`Sheet "${SHEET_NAME}" not found.`);
      return false;
    }
    
    const sourceRange = sheet.getRange(COPY_RANGE);
    const targetRange = sheet.getRange(PASTE_RANGE);

    // Copy values from source to target
    const values = sourceRange.getValues();
    targetRange.setValues(values);

    console.log("Values copied successfully.");
    return true;
  } catch (error) {
    console.error("Error during copy-paste operation: ", error);
    return false;
  }
}
