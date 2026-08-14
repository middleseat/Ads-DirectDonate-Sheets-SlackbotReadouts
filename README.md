# Slack Bot for Google Sheets Readout Documentation

## Overview
This Slack Bot sends a formatted readout from a Google Sheets document to a specified Slack channel or thread. It dynamically fetches data from the sheet, formats it into a readable message, and posts it to Slack.

## Configuration
Before using the bot, you need to configure it with the correct Slack channel ID, the data range from which to fetch data in your Google Sheets document, and optionally, a Slack thread URL, notes range, and ranges for copying and pasting values within the sheet. Additionally, you must set up an OAuth token as a script property for authentication with the Slack API.

### Setting Up Slack Channel ID, Data Range, and Optional Configurations
1. **Open the Google Apps Script File:** Navigate to Extensions > Apps Script from within your Google Sheets document.
2. **Configure Constants:**
   At the top of the `googleAppsScriptCode.gs` file, you'll find configurable constants:
   - `SLACK_CHANNEL_ID`: Replace `'U0127C7UF16'` with the ID of your target Slack channel.
   - `DATA_RANGE_START`: Replace `'B35'` with the starting cell of your data range. The script will automatically extend this range to include relevant data.
   - `SLACK_THREAD_URL`: (Optional) Replace with your thread URL if you want to post to a specific thread. Leave blank to post directly to the channel.
   - `NOTES_RANGE`: (Optional) Replace `'E43:E'` with the range from which to fetch notes. Leave blank if not used.
   - `COPY_RANGE`: (Optional) Replace `'B14:U17'` with the range of cells to copy from.
   - `PASTE_RANGE`: (Optional) Replace `'B26:U29'` with the range of cells to paste to.
   ```javascript
   // Configurable constants
   const SLACK_CHANNEL_ID = 'YOUR_SLACK_CHANNEL_ID'; // Update this with your actual channel ID
   const DATA_RANGE_START = 'B35'; // Update this if you want to start from a different cell
   const SLACK_THREAD_URL = ''; // Optional: Update this with your thread URL
   const NOTES_RANGE = 'E43:E'; // Optional: Update this with your notes range
   const COPY_RANGE = 'B14:U17'; // Optional: Update this with your copy range
   const PASTE_RANGE = 'B26:U29'; // Optional: Update this with your paste range
   ```
> **Obtaining Slack Channel ID:**  
> To locate your Slack channel ID, follow these steps:  
> 1. Open Slack and navigate to your desired channel.  
> 2. Click on the channel name at the top to view channel details.  
> 3. Find the channel ID either in the URL or the "About" section of the channel details.


3. **Set Up OAuth Token as a Script Property:**
   - Go to the Script Editor by navigating to Extensions > Apps Script.
   - In the Apps Script editor, click on `File` > `Project properties` > `Script properties`.
   - Click `Add row`.
   - Enter `SLACK_OAUTH_TOKEN` as the property name.
   - Paste your Slack OAuth token as the value.
   - Click `Save`.
   
   This OAuth token is used for authentication with the Slack API and allows your script to post messages to your Slack workspace.

4. **Deploy:** After making the necessary changes, you need to deploy the script to apply them. Follow these steps to deploy:
   1. Click `Deploy` > `New Deployment`.
   2. On the left sidebar, click the icon next to `Select Type`, then select `Web App`.
      - **Description:** You can leave this empty or add the version number.
      - **Deploy as:** Choose `User accessing the app`.
      - **Who with access:** Select `Anyone within [Your Organization Name]`.
   3. Click `Deploy` then `Done`. You can now close the page.



## Usage
After configuring the bot, you can trigger the readout to be sent to Slack directly from your Google Sheets document.
1. **Open the Google Sheets Document:** Ensure you're in the document configured with the bot.
2. **Send Readout to Slack:** Navigate to the custom menu item Slack Bot > Send Readout to Slack. This fetches the data from the specified range and opens a preview of the exact message. Nothing is posted until you approve it.

### Preview and Mid-Refresh Checks
Every figure in the readout is cumulative, and each "Since Last Update" line is the current pull minus the snapshot in `PASTE_RANGE`. While a data connector is still writing, the current pull comes back partial — spend keeps climbing while raised and donations fall off a cliff, and ROI blows past any real number. The figures still look precise, which is why they get sent by mistake.

The preview shows the message as Slack will render it and flags anything that cannot be a real result:

**Blocks the send** (the Send button stays disabled until you tick "I checked the sheet — send it anyway"):
- A cell that has not calculated — `#N/A`, `#REF!`, a blank where a number belongs. These post to Slack as `$NaN`.
- A negative Spent, Raised or Donations figure, in the totals or in a "Since Last Update" line. Running totals only go up, so a negative delta means this pull came back lower than the last snapshot.
- A "Since Last Update" figure larger than the total it came out of, which means the baseline snapshot is wrong.
- Money raised with zero donations, or donations with zero money raised.
- No campaign data in the range at all.

**Flagged but sendable:**
- ROI below 0% or above `MAX_PLAUSIBLE_ROI` (default 1000%).
- Zero spend on a campaign that is reporting results.
- Every "Since Last Update" figure at exactly zero, which usually means the readout already went out today.
- A note in `NOTES_RANGE` that has not calculated.

The message is built from the rows the preview was built from, so a refresh landing between the preview and the click cannot change what you approved. Set `PREVIEW_BEFORE_SENDING = false` to go back to sending immediately. Time-based triggers and runs from the Apps Script editor skip the preview automatically, since there is no spreadsheet UI to open a dialog in.

A successful send takes over the dialog with a check mark, a short confetti burst and a summary of what happened — how many campaigns posted, where, and that the baseline has been reset — then closes itself. The animation respects the operating system's reduce-motion setting.

If the message posts but the copy-paste step fails, the dialog says so and stays put rather than closing, and the Send button stays disabled — the readout is already in the channel, so a second click would post the whole thing twice.

### Including Notes in Your Readout
If you have configured a `NOTES_RANGE`, the script will fetch each note from this range and include it at the top of your Slack message. Notes starting with an emoji pattern (`:word:`) will retain their custom emoji. Otherwise, notes will be prefixed with a :warning: emoji to highlight them.

### Posting in a Thread
If you have provided a `SLACK_THREAD_URL` in the configuration, the message will be sent as a reply to the specified thread. To post to a different thread, simply update the `SLACK_THREAD_URL` with the new thread's URL. Leave `SLACK_THREAD_URL` blank to post directly to the channel.

**Important Note on Thread URLs:**  
To ensure your message correctly threads in Slack, your `SLACK_THREAD_URL` must include a thread timestamp (`thread_ts`). This often means copying the link of the **second message** in the thread to get a URL with the necessary `thread_ts`.  
**Example Thread URL with `thread_ts`:**  
`https://workspace.slack.com/archives/C0123456D/p1234567890?thread_ts=1709043099.993519&cid=C123456D`

### Copy and Paste Ranges
If you have configured `COPY_RANGE` and `PASTE_RANGE` in the configuration, the script will automatically copy data from the `COPY_RANGE` and paste it into the `PASTE_RANGE` before sending the readout.

## Companion Script: Budget Watchdog
`budgetWatchdog/budgetWatchdog.gs` is a separate script with its own version number and configuration. Where the readout bot reports when someone asks it to, the watchdog runs on a schedule and posts when a campaign is close to — or already past — its spend cap, so nobody has to open the sheet to catch it. It shares only the `SLACK_OAUTH_TOKEN` script property with the readout bot.

It needs the Sheets advanced service enabled and `installWatchdogTriggers()` run once, and it adds a trigger authorization scope to the project. Setup, the `AE:AO` sheet layout it expects, and troubleshooting are in [documentation/budgetWatchdog.md](documentation/budgetWatchdog.md).