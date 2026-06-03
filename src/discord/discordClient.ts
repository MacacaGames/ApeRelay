import { Client, GatewayIntentBits, type Message } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { normalizeDiscordMessage } from '../normalizer/discordNormalizer.js';
import { sendToSlack } from '../slack/slackNotifier.js';
import { getDiscordRelayRuntimeConfig } from '../admin/relayRuleStore.js';
import type { DiscordRelayRule, DiscordSourceGuildOption } from '../types.js';

type AllowCheck = {
  allowed: boolean;
  guildAllowed: boolean;
  channelAllowed: boolean;
  channelCandidateIds: string[];
};

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

function getChannelCandidateIds(message: Message): string[] {
  if (!message.channel || !("id" in message.channel)) {
    return [];
  }

  const ids = [message.channel.id];
  if ("parentId" in message.channel && message.channel.parentId) {
    ids.push(message.channel.parentId);
  }

  return ids;
}

function isAllowedMessage(message: Message): AllowCheck {
  if (!message.guild || !message.channel || !('id' in message.channel)) {
    return {
      allowed: false,
      guildAllowed: false,
      channelAllowed: false,
      channelCandidateIds: [],
    };
  }

  const channelCandidateIds = getChannelCandidateIds(message);

  const guildAllowed =
    config.discord.allowedGuildIds.length === 0 ||
    config.discord.allowedGuildIds.includes(message.guild.id);

  const channelAllowed =
    config.discord.allowedChannelIds.length === 0 ||
    channelCandidateIds.some((id) => config.discord.allowedChannelIds.includes(id));

  return {
    allowed: guildAllowed && channelAllowed,
    guildAllowed,
    channelAllowed,
    channelCandidateIds,
  };
}

function findMatchingRule(
  rules: DiscordRelayRule[],
  guildId: string,
  channelCandidateIds: string[],
): DiscordRelayRule | null {
  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }

    if (rule.sourceGuildId !== guildId) {
      continue;
    }

    if (!channelCandidateIds.includes(rule.sourceChannelId)) {
      continue;
    }

    return rule;
  }

  return null;
}

function shouldExcludeAuthor(
  message: Message,
  globalExcludedAuthorIds: string[],
  rule?: DiscordRelayRule | null,
): boolean {
  const authorId = message.author?.id;
  if (!authorId) {
    return false;
  }

  const excluded = new Set<string>(config.discord.excludedUserIds);
  for (const id of globalExcludedAuthorIds) {
    excluded.add(id);
  }
  for (const id of rule?.excludedAuthorIds ?? []) {
    excluded.add(id);
  }

  return excluded.has(authorId);
}

export async function startDiscordClient(): Promise<void> {
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
    'Discord relay allowlist loaded',
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
    logger.info({ user: client.user?.tag }, 'Discord bot connected');
  });

  discordClientRef = client;

  client.on('messageCreate', async (message) => {
    if (message.author.bot) {
      return;
    }

    rememberDiscordAuthor(message);

    const channelCandidateIds = getChannelCandidateIds(message);
    const guildId = message.guild?.id;
    const runtimeConfig = await getDiscordRelayRuntimeConfig();
    const rules = runtimeConfig.rules;

    if (guildId) {
      const matchedRule = findMatchingRule(rules, guildId, channelCandidateIds);
      if (matchedRule) {
        if (shouldExcludeAuthor(message, runtimeConfig.globalExcludedAuthorIds, matchedRule)) {
          logger.info(
            {
              messageId: message.id,
              authorId: message.author.id,
              ruleId: matchedRule.id,
            },
            'Skip Discord message due to excluded author',
          );
          return;
        }

        const normalizedByRule = normalizeDiscordMessage(message);
        if (!normalizedByRule) {
          logger.info({ messageId: message.id }, 'Skip unsupported Discord message');
          return;
        }

        try {
          await sendToSlack(
            normalizedByRule,
            matchedRule.targetSlackChannel,
            matchedRule.mentionTargets,
          );
          logger.info(
            { messageId: message.id, ruleId: matchedRule.id, ruleName: matchedRule.name },
            'Forwarded Discord message via admin rule',
          );
        } catch (err) {
          logger.error(
            { err, messageId: message.id, ruleId: matchedRule.id },
            'Failed to forward Discord message via admin rule',
          );
        }
        return;
      }
    }

    if (shouldExcludeAuthor(message, runtimeConfig.globalExcludedAuthorIds)) {
      logger.info(
        { messageId: message.id, authorId: message.author.id },
        'Skip Discord message due to excluded author',
      );
      return;
    }

    const allowCheck = isAllowedMessage(message);
    if (!allowCheck.allowed) {
      logger.info(
        {
          guildId: message.guild?.id,
          channelId: 'id' in message.channel ? message.channel.id : undefined,
          channelCandidateIds: allowCheck.channelCandidateIds,
          guildAllowed: allowCheck.guildAllowed,
          channelAllowed: allowCheck.channelAllowed,
          configuredGuildIds: config.discord.allowedGuildIds,
          configuredChannelIds: config.discord.allowedChannelIds,
        },
        'Skip Discord message due to allowlist mismatch',
      );
      return;
    }

    const normalized = normalizeDiscordMessage(message);
    if (!normalized) {
      logger.info({ messageId: message.id }, 'Skip unsupported Discord message');
      return;
    }

    try {
      await sendToSlack(normalized);
    } catch (err) {
      logger.error({ err, messageId: message.id }, 'Failed to forward Discord message to Slack');
    }
  });

  try {
    await client.login(config.discord.botToken);
  } catch (err) {
    logger.error({ err }, 'Discord bot login failed; service continues without Discord relay');
  }
}

export function getDiscordSourceOptions(): {
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

export function getDiscordRecentAuthorOptions(guildId?: string): Array<{
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
