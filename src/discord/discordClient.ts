import { Client, GatewayIntentBits, type Message } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { normalizeDiscordMessage } from '../normalizer/discordNormalizer.js';
import { sendToSlack } from '../slack/slackNotifier.js';
import { getDiscordRelayRules } from '../admin/relayRuleStore.js';
import type { DiscordRelayRule, DiscordSourceGuildOption } from '../types.js';

type AllowCheck = {
  allowed: boolean;
  guildAllowed: boolean;
  channelAllowed: boolean;
  channelCandidateIds: string[];
};

let discordClientRef: Client | null = null;
let discordClientReady = false;

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

export async function startDiscordClient(): Promise<void> {
  if (!config.discord.botToken || config.discord.botToken.startsWith('your_')) {
    logger.warn('Discord integration disabled: DISCORD_BOT_TOKEN is missing or placeholder');
    return;
  }

  logger.info(
    {
      allowedGuildIds: config.discord.allowedGuildIds,
      allowedChannelIds: config.discord.allowedChannelIds,
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

    const channelCandidateIds = getChannelCandidateIds(message);
    const guildId = message.guild?.id;
    const rules = await getDiscordRelayRules();

    if (guildId) {
      const matchedRule = findMatchingRule(rules, guildId, channelCandidateIds);
      if (matchedRule) {
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
