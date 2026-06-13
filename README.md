# Discord Screenshot Hall of Fame Bot

This bot watches one screenshot channel. When an image post reaches the configured reaction threshold, it re-uploads the image to your `hall-of-fame` channel and remembers that message so it will not be promoted twice.

It also deletes non-bot messages posted in the hall-of-fame channel. You should still lock the channel permissions so normal members cannot send messages there.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the example config:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env`:

   - `DISCORD_TOKEN`: your bot token from the Discord Developer Portal.
   - `SCREENSHOT_CHANNEL_ID`: the channel where screenshots are posted.
   - `HALL_OF_FAME_CHANNEL_ID`: the channel where winning screenshots are reposted.
   - `UPVOTE_THRESHOLD`: defaults to `5`.
   - `UPVOTE_EMOJI`: defaults to `👍`.

4. In the Discord Developer Portal, enable these bot intents:

   - Server Members Intent is not required.
   - Message Content Intent is required so the bot can inspect message attachments.

5. Invite the bot with these permissions:

   - View Channels
   - Read Message History
   - Add Reactions
   - Send Messages
   - Attach Files
   - Manage Messages

6. Run the bot:

   ```bash
   npm start
   ```

## Recommended Discord Channel Permissions

For `hall-of-fame`, deny `Send Messages` for regular members and allow it only for the bot. The bot still includes a cleanup guard, but channel permissions are the best way to prevent extra messages.
