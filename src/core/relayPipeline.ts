import { getDiscordRelayRuntimeConfig } from '../admin/relayRuleStore.js';
import { getLineRelayRuntimeConfig } from '../admin/relayRuleStore.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sendToSlack } from '../slack/slackNotifier.js';
import type { DiscordRelayRule, LineRelayRule, UnifiedMessage } from '../types.js';

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
  line?: {
    groupId?: string;
    speakerId?: string;
  };
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

function findMatchingLineRule(rules: LineRelayRule[], groupId: string): LineRelayRule | null {
  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }

    if (rule.sourceGroupId !== groupId) {
      continue;
    }

    return rule;
  }

  return null;
}

function shouldExcludeLineSpeaker(
  rule: LineRelayRule,
  globalExcludedLineSpeakerIds: string[],
  speakerId: string | undefined,
): boolean {
  if (!speakerId) {
    return false;
  }

  const excluded = new Set<string>();
  for (const id of globalExcludedLineSpeakerIds) {
    excluded.add(id);
  }
  for (const id of rule.excludedSpeakerIds ?? []) {
    excluded.add(id);
  }

  return excluded.has(speakerId);
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
  if (input.source === 'line') {
    const lineCtx = input.line;
    if (!lineCtx?.groupId) {
      logger.info('Skip LINE message because source groupId is missing');
      return { forwarded: false, reason: 'line-missing-group-id' };
    }

    const runtimeConfig = await getLineRelayRuntimeConfig();
    const matchedRule = findMatchingLineRule(runtimeConfig.rules, lineCtx.groupId);

    if (!matchedRule) {
      logger.info(
        {
          sourceGroupId: lineCtx.groupId,
        },
        'Skip LINE message because no matching enabled LINE rule',
      );
      return { forwarded: false, reason: 'line-no-matching-rule' };
    }

    if (shouldExcludeLineSpeaker(matchedRule, runtimeConfig.globalExcludedLineSpeakerIds, lineCtx.speakerId)) {
      logger.info(
        {
          sourceGroupId: lineCtx.groupId,
          speakerId: lineCtx.speakerId,
          ruleId: matchedRule.id,
        },
        'Skip LINE message due to excluded speaker',
      );
      return { forwarded: false, reason: 'line-speaker-excluded' };
    }

    await sendToSlack(input.message, matchedRule.targetSlackChannel, matchedRule.mentionTargets);
    return { forwarded: true };
  }

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
      {
        messageId: discordCtx.messageId,
        ruleId: matchedRule.id,
        ruleName: matchedRule.name,
        mentionTargets: matchedRule.mentionTargets ?? [],
      },
      'Forwarded Discord message via admin rule',
    );
    return { forwarded: true };
  }

  if (runtimeConfig.rules.some((rule) => rule.enabled)) {
    logger.info(
      {
        messageId: discordCtx.messageId,
        guildId: discordCtx.guildId,
        channelCandidateIds: discordCtx.channelCandidateIds,
        configuredRules: runtimeConfig.rules
          .filter((rule) => rule.enabled)
          .map((rule) => ({
            id: rule.id,
            name: rule.name,
            sourceGuildId: rule.sourceGuildId,
            sourceChannelId: rule.sourceChannelId,
          })),
      },
      'Skip Discord message because no admin rule matched',
    );
    return { forwarded: false, reason: 'discord-no-matching-rule' };
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
