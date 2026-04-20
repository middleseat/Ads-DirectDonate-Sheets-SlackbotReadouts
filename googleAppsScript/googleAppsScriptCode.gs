/**
 * Slack Bot for Google Sheets Readout
 * Version: 3.2.0
 * Author: Ryan Mioduski
 *
 * Important:
 * Before using the bot, you need to configure it with the correct Slack channel ID and
 * the data range from which to fetch data in your Google Sheets document. Optionally,
 * you can also specify a Slack thread URL to direct the message to a specific thread,
 * a notes range for including flags at the top of the readouts, and ranges for copying
 * and pasting values within the sheet as part of the operation.
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
const CANVAS_URL = 'https://middleseat.slack.com/docs/T250LF79S/F09CA4C66TX'; // Optional: Slack Canvas URL to update
const CANVAS_TITLE = 'Readouts Canvas'; // Optional: for logging/reference
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

function sendSlackMessage() {
  console.log("Preparing to send Slack message");
  const notes = getNotes(); // Fetch notes
  const data = getSheetData();
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
  const response = UrlFetchApp.fetch(slackApiUrl, options);
  const responseJson = JSON.parse(response.getContentText());

  // Check if the Slack message was successfully sent
  let slackMessageSuccess = true;
  if (!responseJson.ok) {
    console.error(`Failed to send message to Slack: ${responseJson.error}`);
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

  // Provide feedback to the user based on the operation outcomes
  if (slackMessageSuccess && copyPasteSuccess) {
    SpreadsheetApp.getUi().alert("Readout Complete!");
  } else if (!slackMessageSuccess) {
    SpreadsheetApp.getUi().alert("Failed to send message to Slack. Please check the logs for more details.");
  } else if (!copyPasteSuccess) {
    SpreadsheetApp.getUi().alert("Readout sent to Slack, but there was an error with the copy-paste operation. Please check the logs for more details.");
  }
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
