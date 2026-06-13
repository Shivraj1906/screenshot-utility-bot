# Discord Screenshot Hall of Fame Bot

This bot watches one screenshot channel. When someone posts images, the bot adds numbered voting reactions (`1️⃣`, `2️⃣`, `3️⃣`, and so on). Each reaction maps to one screenshot in that message. When a specific screenshot reaches the reaction threshold, the bot re-uploads only that screenshot to your `hall-of-fame` channel, tags the original sender, and records the promotion in SQLite so it will not be promoted twice.

If multiple screenshots are waiting for votes, the bot can send an `@here` reminder in the configured reminder channel. It sends at most one reminder per configured interval, and only when new unpromoted screenshots were posted since the last reminder.

Logs are emitted as structured JSON with event names and context fields, which makes them easy to search in systemd, Docker, or a hosted log service.

It also deletes non-bot messages posted in the hall-of-fame channel. You should still lock the channel permissions so normal members cannot send messages there.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create or edit `.env`:

   - `DISCORD_TOKEN`: your bot token from the Discord Developer Portal.
   - `SCREENSHOT_CHANNEL_ID`: the channel where screenshots are posted.
   - `HALL_OF_FAME_CHANNEL_ID`: the channel where winning screenshots are reposted.
   - `REMINDER_CHANNEL_ID`: the channel where `@here` reminder messages are sent.
   - `UPVOTE_THRESHOLD`: defaults to `5`.
   - `SCREENSHOT_DB_PATH`: defaults to `data/screenshots.sqlite`.
   - `LOG_LEVEL`: defaults to `info`. Supported values are `debug`, `info`, `warn`, and `error`.
   - `REMINDERS_ENABLED`: defaults to `true`. Set to `false` to disable `@here` reminders.
   - `REMINDER_INTERVAL_HOURS`: defaults to `24`.
   - `REMINDER_CHECK_MINUTES`: defaults to `15`.

3. In the Discord Developer Portal, enable these bot intents:

   - Server Members Intent is not required.
   - Message Content Intent is required so the bot can inspect message attachments.

4. Invite the bot with these permissions:

   - View Channels
   - Read Message History
   - Add Reactions
   - Send Messages
   - Attach Files
   - Manage Messages
   - Mention Everyone

5. Run the bot:

   ```bash
   npm start
   ```

## Docker

Build and run with Docker Compose:

```bash
docker compose up -d --build
```

View logs:

```bash
docker compose logs -f
```

Stop the bot:

```bash
docker compose down
```

The compose file reads environment variables from `.env` and mounts a Docker-managed `bot-data` volume into the container at `/app/data`, so the SQLite database survives container rebuilds and restarts without host directory permission issues.

To run without Compose:

```bash
docker build -t discord-screenshot-hof-bot .
docker run -d \
  --name discord-screenshot-hof-bot \
  --restart unless-stopped \
  --env-file .env \
  -e SCREENSHOT_DB_PATH=/app/data/screenshots.sqlite \
  -v screenshot-bot-data:/app/data \
  discord-screenshot-hof-bot
```

If you deliberately use a host bind mount like `./data:/app/data`, make sure the container user can write to it:

```bash
mkdir -p data
sudo chown -R 1000:1000 data
```

## Recommended Discord Channel Permissions

For `hall-of-fame`, deny `Send Messages` for regular members and allow it only for the bot. The bot still includes a cleanup guard, but channel permissions are the best way to prevent extra messages.

## Data

The bot creates a SQLite database at `data/screenshots.sqlite` by default. This file tracks screenshot message IDs, attachment IDs, source URLs, promotion state, hall-of-fame message IDs, and vote counts. The `data/` directory is ignored by git.
