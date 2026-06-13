import 'dotenv/config';
import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const config = {
  token: mustGetEnv('DISCORD_TOKEN'),
  screenshotChannelId: mustGetEnv('SCREENSHOT_CHANNEL_ID'),
  hallOfFameChannelId: mustGetEnv('HALL_OF_FAME_CHANNEL_ID'),
  reminderChannelId: process.env.REMINDER_CHANNEL_ID,
  upvoteThreshold: Number.parseInt(process.env.UPVOTE_THRESHOLD ?? '5', 10),
  screenshotDbPath: process.env.SCREENSHOT_DB_PATH ?? 'data/screenshots.sqlite',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  remindersEnabled: process.env.REMINDERS_ENABLED !== 'false',
  reminderIntervalHours: Number.parseFloat(process.env.REMINDER_INTERVAL_HOURS ?? '24'),
  reminderCheckMinutes: Number.parseFloat(process.env.REMINDER_CHECK_MINUTES ?? '15'),
};

if (!Number.isInteger(config.upvoteThreshold) || config.upvoteThreshold < 1) {
  throw new Error('UPVOTE_THRESHOLD must be a positive integer.');
}

if (!Number.isFinite(config.reminderIntervalHours) || config.reminderIntervalHours <= 0) {
  throw new Error('REMINDER_INTERVAL_HOURS must be a positive number.');
}

if (!Number.isFinite(config.reminderCheckMinutes) || config.reminderCheckMinutes <= 0) {
  throw new Error('REMINDER_CHECK_MINUTES must be a positive number.');
}

if (config.remindersEnabled && !config.reminderChannelId) {
  throw new Error('REMINDER_CHANNEL_ID is required when reminders are enabled.');
}

const imageContentTypes = new Set([
  'image/apng',
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const singleScreenshotReaction = '⭐';
const numberReactions = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const activePromotions = new Set();

const logger = createLogger(config.logLevel);
const screenshotStore = await createScreenshotStore(config.screenshotDbPath);
let isShuttingDown = false;
let reminderTimer;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

client.once('clientReady', () => {
  logger.info('bot_ready', {
    botTag: client.user.tag,
    botId: client.user.id,
    screenshotChannelId: config.screenshotChannelId,
    hallOfFameChannelId: config.hallOfFameChannelId,
    reminderChannelId: config.reminderChannelId,
    upvoteThreshold: config.upvoteThreshold,
    reactionMode: 'star_or_numbered',
    remindersEnabled: config.remindersEnabled,
    reminderIntervalHours: config.reminderIntervalHours,
  });

  startReminderLoop();
});

client.on('messageCreate', async (message) => {
  if (!message.author.bot && message.channelId === config.screenshotChannelId) {
    await addUpvoteReaction(message);
    return;
  }

  if (message.channelId !== config.hallOfFameChannelId) {
    return;
  }

  if (message.author.id === client.user?.id) {
    return;
  }

  try {
    await message.delete();
    logger.warn('hall_of_fame_message_deleted', {
      messageId: message.id,
      authorId: message.author.id,
      channelId: message.channelId,
    });
  } catch (error) {
    logger.error('hall_of_fame_delete_failed', {
      error,
      messageId: message.id,
      authorId: message.author.id,
      channelId: message.channelId,
    });
  }
});

client.on('messageReactionAdd', async (reaction) => {
  try {
    if (reaction.partial) {
      reaction = await reaction.fetch();
    }

    const message = reaction.message.partial
      ? await reaction.message.fetch()
      : reaction.message;

    if (message.channelId !== config.screenshotChannelId) {
      return;
    }

    const imageAttachments = getImageAttachments(message);
    const attachmentIndex = getAttachmentIndexForReaction(reaction, imageAttachments.length);

    if (attachmentIndex === -1) {
      return;
    }

    const upvoteCount = await countMemberUpvotes(reaction);

    logger.debug('screenshot_vote_counted', {
      messageId: message.id,
      attachmentIndex,
      channelId: message.channelId,
      emoji: reaction.emoji.name,
      upvoteCount,
      threshold: config.upvoteThreshold,
    });

    if (upvoteCount < config.upvoteThreshold) {
      return;
    }

    await promoteScreenshot(message, attachmentIndex, upvoteCount, imageAttachments);
  } catch (error) {
    logger.error('reaction_handler_failed', { error });
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await client.login(config.token);

async function shutdown() {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info('bot_shutdown_started');

  try {
    if (reminderTimer) {
      clearInterval(reminderTimer);
    }

    await client.destroy();
    screenshotStore.close();
    logger.info('bot_shutdown_finished');
  } catch (error) {
    logger.error('bot_shutdown_failed', { error });
  } finally {
    process.exit(0);
  }
}

function mustGetEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getAttachmentIndexForReaction(reaction, attachmentCount) {
  if (attachmentCount === 1 && reaction.emoji.name === singleScreenshotReaction) {
    return 0;
  }

  if (attachmentCount > 1) {
    return numberReactions.findIndex((emoji) => reaction.emoji.name === emoji);
  }

  return -1;
}

async function countMemberUpvotes(reaction) {
  const users = await reaction.users.fetch();

  return users.filter((user) => user.id !== client.user?.id && !user.bot).size;
}

function getImageAttachments(message) {
  return [...message.attachments.values()].filter((attachment) => {
    if (attachment.contentType && imageContentTypes.has(attachment.contentType.toLowerCase())) {
      return true;
    }

    return /\.(apng|avif|gif|jpe?g|png|webp)$/i.test(attachment.name ?? attachment.url);
  });
}

async function addUpvoteReaction(message) {
  const imageAttachments = getImageAttachments(message);

  if (imageAttachments.length === 0) {
    return;
  }

  if (imageAttachments.length > numberReactions.length) {
    logger.warn('screenshot_reactions_skipped_too_many_attachments', {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
      attachmentCount: imageAttachments.length,
      supportedAttachmentCount: numberReactions.length,
    });
    return;
  }

  try {
    screenshotStore.track(message, imageAttachments);

    const reactionEmojis = getReactionEmojisForAttachments(imageAttachments.length);

    for (const reactionEmoji of reactionEmojis) {
      await message.react(reactionEmoji);
    }

    logger.info('screenshot_reactions_added', {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
      attachmentCount: imageAttachments.length,
      emojis: reactionEmojis,
    });
  } catch (error) {
    logger.error('screenshot_reactions_add_failed', {
      error,
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
    });
  }
}

function getReactionEmojisForAttachments(attachmentCount) {
  if (attachmentCount === 1) {
    return [singleScreenshotReaction];
  }

  return numberReactions.slice(0, attachmentCount);
}

async function promoteScreenshot(message, attachmentIndex, upvoteCount, imageAttachments = getImageAttachments(message)) {
  const attachment = imageAttachments[attachmentIndex];

  if (!attachment) {
    logger.warn('screenshot_promotion_skipped_missing_attachment', {
      messageId: message.id,
      channelId: message.channelId,
      attachmentIndex,
      upvoteCount,
    });
    return;
  }

  const promotionKey = `${message.id}:${attachment.id}`;

  if (activePromotions.has(promotionKey)) {
    logger.debug('screenshot_already_promoted', {
      messageId: message.id,
      attachmentId: attachment.id,
      attachmentIndex,
      upvoteCount,
    });
    return;
  }

  if (screenshotStore.isPromoted(message.id, attachment.id)) {
    logger.debug('screenshot_already_promoted', {
      messageId: message.id,
      attachmentId: attachment.id,
      attachmentIndex,
      upvoteCount,
    });
    return;
  }

  activePromotions.add(promotionKey);

  try {
    screenshotStore.track(message, imageAttachments);

    const hallOfFameChannel = await client.channels.fetch(config.hallOfFameChannelId);

    if (!hallOfFameChannel?.isTextBased()) {
      throw new Error('HALL_OF_FAME_CHANNEL_ID must point to a text-based channel.');
    }

    const file = await downloadAttachment(attachment);
    const authorName = message.member?.displayName ?? message.author.username;

    const hallOfFameMessage = await hallOfFameChannel.send({
      content: `Hall of Fame screenshot #${attachmentIndex + 1} from <@${message.author.id}> (${authorName})\nOriginal: ${message.url}`,
      files: [file],
      allowedMentions: { users: [message.author.id] },
    });

    screenshotStore.markPromoted(message.id, attachment.id, hallOfFameMessage.id, upvoteCount);
    logger.info('screenshot_promoted', {
      messageId: message.id,
      attachmentId: attachment.id,
      attachmentIndex,
      hallOfFameMessageId: hallOfFameMessage.id,
      channelId: message.channelId,
      hallOfFameChannelId: hallOfFameMessage.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
      upvoteCount,
    });
  } finally {
    activePromotions.delete(promotionKey);
  }
}

function startReminderLoop() {
  if (!config.remindersEnabled) {
    logger.info('reminders_disabled');
    return;
  }

  void sendReminderIfNeeded();
  reminderTimer = setInterval(() => {
    void sendReminderIfNeeded();
  }, config.reminderCheckMinutes * 60 * 1000);
}

async function sendReminderIfNeeded() {
  try {
    const reminder = screenshotStore.getReminderCandidate(config.reminderIntervalHours);

    if (!reminder.shouldSend) {
      logger.debug('screenshot_reminder_skipped', reminder);
      return;
    }

    const reminderChannel = await client.channels.fetch(config.reminderChannelId);

    if (!reminderChannel?.isTextBased()) {
      throw new Error('REMINDER_CHANNEL_ID must point to a text-based channel.');
    }

    const reminderMessage = await reminderChannel.send({
      content: `@here ${reminder.pendingCount} screenshots are waiting for votes. React with the emoji under each screenshot post to help pick the next #hall-of-fame⭐ entries.`,
      allowedMentions: { parse: ['everyone'] },
    });

    screenshotStore.markReminderSent();
    logger.info('screenshot_reminder_sent', {
      messageId: reminderMessage.id,
      channelId: reminderMessage.channelId,
      pendingCount: reminder.pendingCount,
      newPendingCount: reminder.newPendingCount,
      reminderIntervalHours: config.reminderIntervalHours,
    });
  } catch (error) {
    logger.error('screenshot_reminder_failed', { error });
  }
}

async function downloadAttachment(attachment) {
  const response = await fetch(attachment.url);

  if (!response.ok) {
    throw new Error(`Failed to download ${attachment.url}: ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const filename = attachment.name ?? `screenshot-${attachment.id}`;

  return new AttachmentBuilder(buffer, { name: filename });
}

async function createScreenshotStore(dbPath) {
  await mkdir(path.dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS screenshots (
      message_id TEXT PRIMARY KEY,
      guild_id TEXT,
      screenshot_channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      original_url TEXT NOT NULL,
      attachment_count INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      promoted_at TEXT,
      hall_of_fame_message_id TEXT,
      upvote_count INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_screenshots_promoted_at
      ON screenshots(promoted_at);

    CREATE TABLE IF NOT EXISTS screenshot_attachments (
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL,
      attachment_index INTEGER NOT NULL,
      guild_id TEXT,
      screenshot_channel_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      original_url TEXT NOT NULL,
      attachment_url TEXT NOT NULL,
      filename TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      promoted_at TEXT,
      hall_of_fame_message_id TEXT,
      upvote_count INTEGER,
      PRIMARY KEY (message_id, attachment_id)
    );

    CREATE INDEX IF NOT EXISTS idx_screenshot_attachments_promoted_at
      ON screenshot_attachments(promoted_at);

    CREATE INDEX IF NOT EXISTS idx_screenshot_attachments_message_index
      ON screenshot_attachments(message_id, attachment_index);

    CREATE TABLE IF NOT EXISTS reminder_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_reminded_at TEXT
    );
  `);

  const statements = {
    trackMessage: db.prepare(`
      INSERT INTO screenshots (
        message_id,
        guild_id,
        screenshot_channel_id,
        author_id,
        original_url,
        attachment_count
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id) DO UPDATE SET
        attachment_count = excluded.attachment_count
    `),
    trackAttachment: db.prepare(`
      INSERT INTO screenshot_attachments (
        message_id,
        attachment_id,
        attachment_index,
        guild_id,
        screenshot_channel_id,
        author_id,
        original_url,
        attachment_url,
        filename
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_id, attachment_id) DO UPDATE SET
        attachment_index = excluded.attachment_index,
        attachment_url = excluded.attachment_url,
        filename = excluded.filename
    `),
    isPromoted: db.prepare(`
      SELECT 1
      FROM screenshot_attachments
      WHERE message_id = ?
        AND attachment_id = ?
        AND promoted_at IS NOT NULL
      LIMIT 1
    `),
    markPromoted: db.prepare(`
      UPDATE screenshot_attachments
      SET promoted_at = CURRENT_TIMESTAMP,
          hall_of_fame_message_id = ?,
          upvote_count = ?
      WHERE message_id = ?
        AND attachment_id = ?
    `),
    getReminderCandidate: db.prepare(`
      WITH state AS (
        SELECT COALESCE(
          (SELECT last_reminded_at FROM reminder_state WHERE id = 1),
          '1970-01-01 00:00:00'
        ) AS last_reminded_at
      )
      SELECT
        COUNT(*) AS pending_count,
        SUM(CASE WHEN screenshot_attachments.created_at > state.last_reminded_at THEN 1 ELSE 0 END) AS new_pending_count,
        CAST(strftime('%s', 'now') - strftime('%s', state.last_reminded_at) AS INTEGER) AS seconds_since_last_reminder
      FROM screenshot_attachments, state
      WHERE promoted_at IS NULL
    `),
    markReminderSent: db.prepare(`
      INSERT INTO reminder_state (id, last_reminded_at)
      VALUES (1, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        last_reminded_at = excluded.last_reminded_at
    `),
  };

  logger.info('screenshot_store_ready', { dbPath });

  return {
    track(message, attachments) {
      statements.trackMessage.run(
        message.id,
        message.guildId,
        message.channelId,
        message.author.id,
        message.url,
        attachments.length,
      );

      attachments.forEach((attachment, attachmentIndex) => {
        statements.trackAttachment.run(
          message.id,
          attachment.id,
          attachmentIndex,
          message.guildId,
          message.channelId,
          message.author.id,
          message.url,
          attachment.url,
          attachment.name ?? null,
        );
      });
    },
    isPromoted(messageId, attachmentId) {
      return Boolean(statements.isPromoted.get(messageId, attachmentId));
    },
    markPromoted(messageId, attachmentId, hallOfFameMessageId, upvoteCount) {
      statements.markPromoted.run(hallOfFameMessageId, upvoteCount, messageId, attachmentId);
    },
    getReminderCandidate(reminderIntervalHours) {
      const row = statements.getReminderCandidate.get();
      const pendingCount = row.pending_count ?? 0;
      const newPendingCount = row.new_pending_count ?? 0;
      const secondsSinceLastReminder = row.seconds_since_last_reminder ?? Number.POSITIVE_INFINITY;
      const reminderIntervalSeconds = reminderIntervalHours * 60 * 60;

      return {
        pendingCount,
        newPendingCount,
        secondsSinceLastReminder,
        shouldSend: pendingCount > 1
          && newPendingCount > 0
          && secondsSinceLastReminder >= reminderIntervalSeconds,
      };
    },
    markReminderSent() {
      statements.markReminderSent.run();
    },
    close() {
      db.close();
    },
  };
}

function createLogger(levelName) {
  const levels = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  };
  const minimumLevel = levels[levelName] ?? levels.info;

  function write(level, event, fields = {}) {
    if (levels[level] < minimumLevel) {
      return;
    }

    const { error, ...rest } = fields;
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...rest,
    };

    if (error) {
      record.error = serializeError(error);
    }

    const line = JSON.stringify(record);

    if (level === 'error') {
      console.error(line);
      return;
    }

    console.log(line);
  }

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

function serializeError(error) {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}
