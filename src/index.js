import 'dotenv/config';
import {
  AttachmentBuilder,
  Client,
  GatewayIntentBits,
  Partials,
} from 'discord.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const config = {
  token: mustGetEnv('DISCORD_TOKEN'),
  screenshotChannelId: mustGetEnv('SCREENSHOT_CHANNEL_ID'),
  hallOfFameChannelId: mustGetEnv('HALL_OF_FAME_CHANNEL_ID'),
  upvoteThreshold: Number.parseInt(process.env.UPVOTE_THRESHOLD ?? '5', 10),
  upvoteEmoji: process.env.UPVOTE_EMOJI ?? '👍',
  promotedStorePath: process.env.PROMOTED_STORE_PATH ?? 'data/promoted-messages.json',
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

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const promotedMessageIds = await loadPromotedMessageIds(config.promotedStorePath);

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`Watching <#${config.screenshotChannelId}> for ${config.upvoteThreshold} ${config.upvoteEmoji} reactions.`);
});

client.on('messageCreate', async (message) => {
  if (message.channelId !== config.hallOfFameChannelId) {
    return;
  }

  if (message.author.id === client.user?.id) {
    return;
  }

  try {
    await message.delete();
  } catch (error) {
    console.error(`Failed to delete non-bot hall-of-fame message ${message.id}:`, error);
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

    if (reaction.count < config.upvoteThreshold) {
      return;
    }

    await promoteMessage(message);
  } catch (error) {
    console.error('Failed to handle reaction:', error);
  }
});

await client.login(config.token);

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

function getImageAttachments(message) {
  return [...message.attachments.values()].filter((attachment) => {
    if (attachment.contentType && imageContentTypes.has(attachment.contentType.toLowerCase())) {
      return true;
    }

    return /\.(apng|avif|gif|jpe?g|png|webp)$/i.test(attachment.name ?? attachment.url);
  });
}

async function promoteMessage(message) {
  if (promotedMessageIds.has(message.id)) {
    return;
  }

  const imageAttachments = getImageAttachments(message);

  if (imageAttachments.length === 0) {
    return;
  }

  const hallOfFameChannel = await client.channels.fetch(config.hallOfFameChannelId);

  if (!hallOfFameChannel?.isTextBased()) {
    throw new Error('HALL_OF_FAME_CHANNEL_ID must point to a text-based channel.');
  }

  const files = await Promise.all(imageAttachments.map(downloadAttachment));
  const authorName = message.member?.displayName ?? message.author.username;

  await hallOfFameChannel.send({
    content: `Hall of Fame screenshot from ${authorName}\nOriginal: ${message.url}`,
    files,
    allowedMentions: { parse: [] },
  });

  promotedMessageIds.add(message.id);
  await savePromotedMessageIds(config.promotedStorePath, promotedMessageIds);
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

async function loadPromotedMessageIds(storePath) {
  try {
    const contents = await readFile(storePath, 'utf8');
    const parsed = JSON.parse(contents);

    if (!Array.isArray(parsed)) {
      throw new Error('Promoted message store must contain a JSON array.');
    }

    return new Set(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return new Set();
    }

    throw error;
  }
}

async function savePromotedMessageIds(storePath, messageIds) {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, `${JSON.stringify([...messageIds], null, 2)}\n`);
}
