import { getDiscordRelayRuntimeConfig } from '../admin/relayRuleStore.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendToSlack } from '../slack/slackNotifier.js';
import type { DiscordRelayRule, UnifiedMessage } from '../types.js';

type DiscordRelayContext = {
  guildId?: string;
  channelCandidateIds: string[];
  authorId?: string;
  messageId?: string;
};

type RelayInput = {
  source: 'discord' | 'line' | 'generic-webhook' | 'test';
  message: UnifiedMessage;
  discord?: DiscordRelayContext;
};

type RelayResult = {
  forwarded: boolean;
  reason?: string;
};

type AllowCheck = {
  allowed: boolean;
  guildAllowed: boolean;
  channelAllowed: boolean;
};

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
  authorId: string | undefined,
  globalExcludedAuthorIds: string[],
  rule?: DiscordRelayRule | null,
): boolean {
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

function isDiscordAllowlisted(guildId: string | undefined, channelCandidateIds: string[]): AllowCheck {
  const guildAllowed =
    !guildId ||
    config.discord.allowedGuildIds.length === 0 ||
    config.discord.allowedGuildIds.includes(guildId);

  const channelAllowed =
    config.discord.allowedChannelIds.length === 0 ||
    channelCandidateIds.some((id) => config.discord.allowedChannelIds.includes(id));

  return {
    allowed: guildAllowed && channelAllowed,
    guildAllowed,
    channelAllowed,
  };
}

export async function relayIncomingMessage(input: RelayInput): Promise<RelayResult> {
  if (input.source !== 'discord') {
    await sendToSlack(input.message);
    return { forwarded: true };
  }

  const discordCtx = input.discord;
  if (!discordCtx) {
    logger.warn('Missing discord context when relaying Discord message');
    return { forwarded: false, reason: 'missing-discord-context' };
  }

  const runtimeConfig = await getDiscordRelayRuntimeConfig();
  const matchedRule = discordCtx.guildId
    ? findMatchingRule(runtimeConfig.rules, discordCtx.guildId, discordCtx.channelCandidateIds)
    : null;

  if (matchedRule) {
    if (shouldExcludeAuthor(discordCtx.authorId, runtimeConfig.globalExcludedAuthorIds, matchedRule)) {
      logger.info(
        {
          messageId: discordCtx.messageId,
          authorId: discordCtx.authorId,
          ruleId: matchedRule.id,
        },
        'Skip Discord message due to excluded author',
      );
      return { forwarded: false, reason: 'excluded-author' };
    }

    await sendToSlack(input.message, matchedRule.targetSlackChannel, matchedRule.mentionTargets);
    logger.info(
      { messageId: discordCtx.messageId, ruleId: matchedRule.id, ruleName: matchedRule.name },
      'Forwarded Discord message via admin rule',
    );
    return { forwarded: true };
  }

  if (shouldExcludeAuthor(discordCtx.authorId, runtimeConfig.globalExcludedAuthorIds)) {
    logger.info(
      { messageId: discordCtx.messageId, authorId: discordCtx.authorId },
      'Skip Discord message due to excluded author',
    );
    return { forwarded: false, reason: 'excluded-author' };
  }

  const allowCheck = isDiscordAllowlisted(discordCtx.guildId, discordCtx.channelCandidateIds);
  if (!allowCheck.allowed) {
    logger.info(
      {
        guildId: discordCtx.guildId,
        channelCandidateIds: discordCtx.channelCandidateIds,
        guildAllowed: allowCheck.guildAllowed,
        channelAllowed: allowCheck.channelAllowed,
        configuredGuildIds: config.discord.allowedGuildIds,
        configuredChannelIds: config.discord.allowedChannelIds,
      },
      'Skip Discord message due to allowlist mismatch',
    );
    return { forwarded: false, reason: 'allowlist-mismatch' };
  }

  await sendToSlack(input.message);
  return { forwarded: true };
}
