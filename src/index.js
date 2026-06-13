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
  upvoteThreshold: Number.parseInt(process.env.UPVOTE_THRESHOLD ?? '5', 10),
  upvoteEmoji: process.env.UPVOTE_EMOJI ?? '⭐',
  screenshotDbPath: process.env.SCREENSHOT_DB_PATH ?? 'data/screenshots.sqlite',
  logLevel: process.env.LOG_LEVEL ?? 'info',
};

if (!Number.isInteger(config.upvoteThreshold) || config.upvoteThreshold < 1) {
  throw new Error('UPVOTE_THRESHOLD must be a positive integer.');
}

const imageContentTypes = new Set([
  'image/apng',
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const logger = createLogger(config.logLevel);
const screenshotStore = await createScreenshotStore(config.screenshotDbPath);
let isShuttingDown = false;

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
    upvoteThreshold: config.upvoteThreshold,
    upvoteEmoji: config.upvoteEmoji,
  });
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

    if (!isConfiguredUpvote(reaction)) {
      return;
    }

    const upvoteCount = await countMemberUpvotes(reaction);

    logger.debug('screenshot_vote_counted', {
      messageId: message.id,
      channelId: message.channelId,
      emoji: reaction.emoji.name,
      upvoteCount,
      threshold: config.upvoteThreshold,
    });

    if (upvoteCount < config.upvoteThreshold) {
      return;
    }

    await promoteMessage(message, upvoteCount);
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

function isConfiguredUpvote(reaction) {
  return reaction.emoji.id === config.upvoteEmoji || reaction.emoji.name === config.upvoteEmoji;
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

  try {
    screenshotStore.track(message, imageAttachments.length);
    await message.react(config.upvoteEmoji);
    logger.info('screenshot_reaction_added', {
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
      attachmentCount: imageAttachments.length,
      emoji: config.upvoteEmoji,
    });
  } catch (error) {
    logger.error('screenshot_reaction_add_failed', {
      error,
      messageId: message.id,
      channelId: message.channelId,
      guildId: message.guildId,
      authorId: message.author.id,
      emoji: config.upvoteEmoji,
    });
  }
}

async function promoteMessage(message, upvoteCount) {
  if (screenshotStore.isPromoted(message.id)) {
    logger.debug('screenshot_already_promoted', {
      messageId: message.id,
      upvoteCount,
    });
    return;
  }

  const imageAttachments = getImageAttachments(message);

  if (imageAttachments.length === 0) {
    logger.warn('screenshot_promotion_skipped_no_images', {
      messageId: message.id,
      channelId: message.channelId,
      upvoteCount,
    });
    return;
  }

  screenshotStore.track(message, imageAttachments.length);

  const hallOfFameChannel = await client.channels.fetch(config.hallOfFameChannelId);

  if (!hallOfFameChannel?.isTextBased()) {
    throw new Error('HALL_OF_FAME_CHANNEL_ID must point to a text-based channel.');
  }

  const files = await Promise.all(imageAttachments.map(downloadAttachment));
  const authorName = message.member?.displayName ?? message.author.username;

  const hallOfFameMessage = await hallOfFameChannel.send({
    content: `Hall of Fame screenshot from ${authorName}\nOriginal: ${message.url}`,
    files,
    allowedMentions: { parse: [] },
  });

  screenshotStore.markPromoted(message, hallOfFameMessage.id, upvoteCount);
  logger.info('screenshot_promoted', {
    messageId: message.id,
    hallOfFameMessageId: hallOfFameMessage.id,
    channelId: message.channelId,
    hallOfFameChannelId: hallOfFameMessage.channelId,
    guildId: message.guildId,
    authorId: message.author.id,
    attachmentCount: imageAttachments.length,
    upvoteCount,
  });
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
  `);

  const statements = {
    track: db.prepare(`
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
    isPromoted: db.prepare(`
      SELECT 1
      FROM screenshots
      WHERE message_id = ?
        AND promoted_at IS NOT NULL
      LIMIT 1
    `),
    markPromoted: db.prepare(`
      UPDATE screenshots
      SET promoted_at = CURRENT_TIMESTAMP,
          hall_of_fame_message_id = ?,
          upvote_count = ?
      WHERE message_id = ?
    `),
  };

  logger.info('screenshot_store_ready', { dbPath });

  return {
    track(message, attachmentCount) {
      statements.track.run(
        message.id,
        message.guildId,
        message.channelId,
        message.author.id,
        message.url,
        attachmentCount,
      );
    },
    isPromoted(messageId) {
      return Boolean(statements.isPromoted.get(messageId));
    },
    markPromoted(message, hallOfFameMessageId, upvoteCount) {
      statements.markPromoted.run(hallOfFameMessageId, upvoteCount, message.id);
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
