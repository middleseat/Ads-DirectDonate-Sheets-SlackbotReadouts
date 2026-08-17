/**
 * Slack Bot for Google Sheets Readout - Update Notification
 * Version: 1.2.0
 * Author: Ryan Mioduski
 *
 * This script sends a notification to a specified Slack channel indicating that the
 * Slack Readout Bot has been updated to a new version, along with the change log.
 *
 * Configuration:
 * - UPDATE_NOTIFICATION_SLACK_CHANNEL_ID: Where the update notification is sent. A channel ID
 *   starts with C — an ID starting with U is a person, and the notification goes to them as a DM.
 * - BOT_VERSION: The new version number of the bot.
 * - CHANGE_LOG: An array of strings, each representing a change in the latest version.
 */

// Configuration
const UPDATE_NOTIFICATION_SLACK_CHANNEL_ID = 'U0127C7UF16'; // Update this with your channel ID
const BOT_VERSION = 'v3.3.0'; // Update this with the new version number
const CHANGE_LOG = [
  "Send Readout to Slack now opens a preview first — nothing posts until you approve it",
  "The preview flags data that is still refreshing: negative \"Since Last Update\" figures, uncalculated cells, and totals that cannot be real",
  "A send that goes through now gets a proper send-off — a check mark, a little confetti, and a summary of what posted and that the baseline was reset",
  "A failed baseline copy can no longer be retried into a double post",
  "Slack Canvas support — set CANVAS_URL to keep a canvas in sync with each readout (3.2.0)",
  "Every operation now reads the Readouts tab instead of whichever tab is active (3.1.0)",
  "The baseline copy only runs when the Slack message actually posted (3.0.2)",
];
// Optional: a separate feature called out below the change log. Leave SPOTLIGHT_TITLE blank to skip it.
const SPOTLIGHT_TITLE = 'New: Budget Watchdog';
const SPOTLIGHT_NOTES = [
  "A second script that watches the FB_data budget block on its own and posts when a campaign is close to, or past, its spend cap — nobody has to open the sheet",
  "Runs four times a day. Out-of-budget alerts repeat until they clear; 10%-of-cap warnings go out once per campaign per day",
  "Stays silent when there is nothing new to report",
  "Set up separately: paste in budgetWatchdog.gs, enable the Sheets advanced service, then run installWatchdogTriggers() once",
];
// End Configuration

function sendUpdateNotification() {
  const slackApiUrl = 'https://slack.com/api/chat.postMessage';
  const scriptProperties = PropertiesService.getScriptProperties();
  const token = scriptProperties.getProperty('SLACK_OAUTH_TOKEN'); // Directly using the property name
  
  if (!token) {
    console.error("Slack OAuth token not found. Please set the token in the script properties.");
    return;
  }

  const payload = {
    channel: UPDATE_NOTIFICATION_SLACK_CHANNEL_ID,
    text: `Slack Readout Bot Updated to ${BOT_VERSION}`,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Slack Readout Bot Updated to ${BOT_VERSION}`,
          emoji: true
        }
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "*Change Log:*"
        }
      },
      ...CHANGE_LOG.map(change => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `- ${change}`
        }
      })),
      // A feature that stands on its own rather than being one line in the change log.
      ...(SPOTLIGHT_TITLE ? [
        {
          type: "divider"
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${SPOTLIGHT_TITLE}*\n${SPOTLIGHT_NOTES.map(note => `- ${note}`).join('\n')}`
          }
        }
      ] : []),
      {
        type: "divider"
      },
      /*
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: {
              type: "plain_text",
              text: "View Documentation",
              emoji: true
            },
            url: "https://github.com/ryanmio/SheetsToSlackBot/releases/tag/v3.0.0",
            action_id: "view_documentation"
          }
        ]
      },
      */
      // Added context block for reauthentication reminder
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "Please note: You will be asked to reauthenticate when running the bot for the first time."
          }
        ]
      }
    ]
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': `Bearer ${token}`
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true // Report a bad response below instead of throwing out of the function
  };

  try {
    const response = UrlFetchApp.fetch(slackApiUrl, options);
    const responseJson = JSON.parse(response.getContentText());
    if (!responseJson.ok) {
      console.error(`Failed to send update notification to Slack: ${responseJson.error}`);
    } else {
      console.log("Update notification sent successfully to Slack.");
    }
  } catch (error) {
    console.error("Error sending update notification to Slack: ", error);
  }
}