import { Client, GatewayIntentBits, type Message } from 'discord.js';
import { config } from '../config.js';
import { relayIncomingMessage } from '../core/relayPipeline.js';
import { logger } from '../logger.js';
import { normalizeDiscordMessage } from '../normalizer/discordNormalizer.js';
import type { DiscordSourceGuildOption } from '../types.js';
import type { SourceAdapter } from './types.js';

type DiscordAuthorCacheItem = {
  id: string;
  displayName: string;
  guildIds: Set<string>;
  lastSeenAt: number;
};

let discordClientRef: Client | null = null;
let discordClientReady = false;
const RECENT_AUTHORS_LIMIT = 300;
const recentDiscordAuthors = new Map<string, DiscordAuthorCacheItem>();

function getChannelCandidateIds(message: Message): string[] {
  if (!message.channel || !('id' in message.channel)) {
    return [];
  }

  const ids = [message.channel.id];
  if ('parentId' in message.channel && message.channel.parentId) {
    ids.push(message.channel.parentId);
  }

  return ids;
}

function rememberDiscordAuthor(message: Message): void {
  const authorId = message.author?.id;
  if (!authorId || message.author?.bot) {
    return;
  }

  const guildId = message.guild?.id;
  const fallbackName = message.author.username || message.author.globalName || authorId;
  const displayName =
    message.member?.displayName?.trim() ||
    message.author.globalName ||
    fallbackName;

  const existing = recentDiscordAuthors.get(authorId);
  if (existing) {
    existing.displayName = displayName;
    existing.lastSeenAt = Date.now();
    if (guildId) {
      existing.guildIds.add(guildId);
    }
  } else {
    recentDiscordAuthors.set(authorId, {
      id: authorId,
      displayName,
      guildIds: new Set(guildId ? [guildId] : []),
      lastSeenAt: Date.now(),
    });
  }

  if (recentDiscordAuthors.size > RECENT_AUTHORS_LIMIT) {
    const sorted = Array.from(recentDiscordAuthors.values()).sort(
      (a, b) => a.lastSeenAt - b.lastSeenAt,
    );
    const overflow = recentDiscordAuthors.size - RECENT_AUTHORS_LIMIT;
    for (let i = 0; i < overflow; i += 1) {
      const item = sorted[i];
      if (item) {
        recentDiscordAuthors.delete(item.id);
      }
    }
  }
}

async function startDiscordSource(): Promise<void> {
  if (!config.discord.botToken || config.discord.botToken.startsWith('your_')) {
    logger.warn('Discord integration disabled: DISCORD_BOT_TOKEN is missing or placeholder');
    return;
  }

  logger.info(
    {
      allowedGuildIds: config.discord.allowedGuildIds,
      allowedChannelIds: config.discord.allowedChannelIds,
      excludedUserIds: config.discord.excludedUserIds,
    },
    'Discord source config loaded',
  );

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('clientReady', () => {
    discordClientReady = true;
    logger.info({ user: client.user?.tag }, 'Discord source connected');
  });

  discordClientRef = client;

  client.on('messageCreate', async (message) => {
    if (message.author.bot) {
      return;
    }

    rememberDiscordAuthor(message);

    const normalized = normalizeDiscordMessage(message);
    if (!normalized) {
      logger.info({ messageId: message.id }, 'Skip unsupported Discord message');
      return;
    }

    try {
      await relayIncomingMessage({
        source: 'discord',
        message: normalized,
        discord: {
          guildId: message.guild?.id,
          channelCandidateIds: getChannelCandidateIds(message),
          authorId: message.author.id,
          messageId: message.id,
        },
      });
    } catch (err) {
      logger.error({ err, messageId: message.id }, 'Failed to relay Discord message');
    }
  });

  try {
    await client.login(config.discord.botToken);
  } catch (err) {
    logger.error({ err }, 'Discord bot login failed; service continues without Discord relay');
  }
}

function getDiscordSourceOptions(): {
  ready: boolean;
  guilds: DiscordSourceGuildOption[];
} {
  if (!discordClientRef || !discordClientReady) {
    return { ready: false, guilds: [] };
  }

  const guilds: DiscordSourceGuildOption[] = [];

  for (const guild of discordClientRef.guilds.cache.values()) {
    const channels = guild.channels.cache
      .filter((channel) => channel.isTextBased() && 'name' in channel)
      .map((channel) => ({
        id: channel.id,
        name: channel.name,
        parentId: 'parentId' in channel ? (channel.parentId ?? undefined) : undefined,
      }));

    guilds.push({
      id: guild.id,
      name: guild.name,
      channels,
    });
  }

  return { ready: true, guilds };
}

function getDiscordRecentAuthorOptions(guildId?: string): Array<{
  id: string;
  displayName: string;
}> {
  return Array.from(recentDiscordAuthors.values())
    .filter((item) => !guildId || item.guildIds.has(guildId))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
    .map((item) => ({
      id: item.id,
      displayName: item.displayName,
    }));
}

export const discordSourceAdapter: SourceAdapter = {
  key: 'discord',
  start: startDiscordSource,
};

export { getDiscordRecentAuthorOptions, getDiscordSourceOptions, startDiscordSource };
