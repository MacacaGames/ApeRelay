import { getDiscordRelayRuntimeConfig } from '../admin/relayRuleStore.js';
import { getLineRelayRuntimeConfig } from '../admin/relayRuleStore.js';
import { getMentionTriggerRuntimeConfig } from '../admin/relayRuleStore.js';
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

type TriggerReason = 'Rule' | 'Mention' | 'Rule + Mention';

function findMatchingRule(
  rules: DiscordRelayRule[],
  guildId: string,
  channelCandidateIds: string[],
): DiscordRelayRule | null {
  let fallbackGuildWideRule: DiscordRelayRule | null = null;

  for (const rule of rules) {
    if (!rule.enabled) {
      continue;
    }

    if (rule.sourceGuildId !== guildId) {
      continue;
    }

    const sourceChannelId = String(rule.sourceChannelId ?? '').trim();
    if (!sourceChannelId) {
      fallbackGuildWideRule = fallbackGuildWideRule ?? rule;
      continue;
    }

    if (!channelCandidateIds.includes(sourceChannelId)) {
      continue;
    }

    return rule;
  }

  return fallbackGuildWideRule;
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

function isGlobalExcludedLineSpeaker(
  globalExcludedLineSpeakerIds: string[],
  speakerId: string | undefined,
): boolean {
  if (!speakerId) {
    return false;
  }

  return globalExcludedLineSpeakerIds.includes(speakerId);
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

function mergeMentions(...mentionLists: Array<string[] | undefined>): string[] {
  const merged = new Set<string>();
  for (const list of mentionLists) {
    for (const item of list ?? []) {
      const value = String(item).trim();
      if (value) {
        merged.add(value);
      }
    }
  }
  return Array.from(merged);
}

function resolveDiscordMentionTriggerMentions(
  guildId: string | undefined,
  mentionedExternalUserIds: string[],
  runtimeConfig: Awaited<ReturnType<typeof getMentionTriggerRuntimeConfig>>,
): string[] {
  const trigger = runtimeConfig.discordMentionTrigger;
  if (!trigger.enabled) {
    return [];
  }

  if (trigger.allowedGuildIds.length > 0 && (!guildId || !trigger.allowedGuildIds.includes(guildId))) {
    return [];
  }

  const mentionedSet = new Set(mentionedExternalUserIds.map((id) => String(id).trim()).filter(Boolean));
  if (mentionedSet.size === 0) {
    return [];
  }

  const directoryMentions = (runtimeConfig.mentionDirectory?.identities ?? [])
    .filter((item) => item.enabled && item.slackMention)
    .filter((item) => (item.discordUserIds ?? []).some((id) => mentionedSet.has(String(id).trim())))
    .map((item) => item.slackMention.trim())
    .filter(Boolean);

  const legacyMentions = trigger.mappings
    .filter((mapping) => mapping.enabled && mapping.discordUserId && mapping.slackMention)
    .filter((mapping) => mentionedSet.has(mapping.discordUserId))
    .map((mapping) => mapping.slackMention.trim())
    .filter(Boolean);

  return mergeMentions(directoryMentions, legacyMentions);
}

function resolveLineMentionTriggerMentions(
  groupId: string | undefined,
  mentionedExternalUserIds: string[],
  runtimeConfig: Awaited<ReturnType<typeof getMentionTriggerRuntimeConfig>>,
): string[] {
  const trigger = runtimeConfig.lineMentionTrigger;
  if (!trigger.enabled) {
    return [];
  }

  if (groupId && trigger.excludedGroupIds.includes(groupId)) {
    return [];
  }

  if (trigger.allowedGroupIds.length > 0) {
    if (!groupId || !trigger.allowedGroupIds.includes(groupId)) {
      return [];
    }
  }

  const mentionedSet = new Set(mentionedExternalUserIds.map((id) => String(id).trim()).filter(Boolean));
  if (mentionedSet.size === 0) {
    return [];
  }

  const directoryMentions = (runtimeConfig.mentionDirectory?.identities ?? [])
    .filter((item) => item.enabled && item.slackMention)
    .filter((item) => (item.lineUserIds ?? []).some((id) => mentionedSet.has(String(id).trim())))
    .map((item) => item.slackMention.trim())
    .filter(Boolean);

  const legacyMentions = trigger.mappings
    .filter((mapping) => mapping.enabled && mapping.lineUserId && mapping.slackMention)
    .filter((mapping) => {
      const channelOk = !mapping.lineChannelId || mapping.lineChannelId === 'default';
      return channelOk && mentionedSet.has(mapping.lineUserId);
    })
    .map((mapping) => mapping.slackMention.trim())
    .filter(Boolean);

  return mergeMentions(directoryMentions, legacyMentions);
}

function getTriggerReason(ruleMatched: boolean, mentionMatched: boolean): TriggerReason {
  if (ruleMatched && mentionMatched) {
    return 'Rule + Mention';
  }
  if (mentionMatched) {
    return 'Mention';
  }
  return 'Rule';
}

export async function relayIncomingMessage(input: RelayInput): Promise<RelayResult> {
  if (input.source === 'line') {
    const lineCtx = input.line;
    if (!lineCtx?.groupId) {
      logger.info('Skip LINE message because source groupId is missing');
      return { forwarded: false, reason: 'line-missing-group-id' };
    }

    const runtimeConfig = await getLineRelayRuntimeConfig();
    const mentionTriggerRuntime = await getMentionTriggerRuntimeConfig();
    const matchedRule = findMatchingLineRule(runtimeConfig.rules, lineCtx.groupId);

    if (isGlobalExcludedLineSpeaker(runtimeConfig.globalExcludedLineSpeakerIds, lineCtx.speakerId)) {
      logger.info(
        {
          sourceGroupId: lineCtx.groupId,
          speakerId: lineCtx.speakerId,
        },
        'Skip LINE message due to global excluded speaker',
      );
      return { forwarded: false, reason: 'line-speaker-excluded-global' };
    }

    if (matchedRule && shouldExcludeLineSpeaker(matchedRule, runtimeConfig.globalExcludedLineSpeakerIds, lineCtx.speakerId)) {
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

    const triggerMentions = resolveLineMentionTriggerMentions(
      lineCtx.groupId,
      input.message.mentionedExternalUserIds ?? [],
      mentionTriggerRuntime,
    );

    if (!matchedRule && triggerMentions.length === 0) {
      logger.info(
        {
          sourceGroupId: lineCtx.groupId,
        },
        'Skip LINE message because neither rule nor mention trigger matched',
      );
      return { forwarded: false, reason: 'line-no-match' };
    }

    const mergedMentions = mergeMentions(matchedRule?.mentionTargets, triggerMentions);
    const reason = getTriggerReason(Boolean(matchedRule), triggerMentions.length > 0);
    await sendToSlack(input.message, matchedRule?.targetSlackChannel, mergedMentions, reason);
    return { forwarded: true };
  }

  if (input.source !== 'discord') {
    await sendToSlack(input.message, undefined, undefined, 'Rule');
    return { forwarded: true };
  }

  const discordCtx = input.discord;
  if (!discordCtx) {
    logger.warn('Missing discord context when relaying Discord message');
    return { forwarded: false, reason: 'missing-discord-context' };
  }

  const runtimeConfig = await getDiscordRelayRuntimeConfig();
  const mentionTriggerRuntime = await getMentionTriggerRuntimeConfig();
  const matchedRule = discordCtx.guildId
    ? findMatchingRule(runtimeConfig.rules, discordCtx.guildId, discordCtx.channelCandidateIds)
    : null;

  const triggerMentions = resolveDiscordMentionTriggerMentions(
    discordCtx.guildId,
    input.message.mentionedExternalUserIds ?? [],
    mentionTriggerRuntime,
  );

  const mentionTriggerMatched = triggerMentions.length > 0;

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

    const mergedMentions = mergeMentions(matchedRule.mentionTargets, triggerMentions);
    const reason = getTriggerReason(true, mentionTriggerMatched);
    await sendToSlack(input.message, matchedRule.targetSlackChannel, mergedMentions, reason);
    logger.info(
      {
        messageId: discordCtx.messageId,
        ruleId: matchedRule.id,
        ruleName: matchedRule.name,
        mentionTargets: mergedMentions,
        triggerReason: reason,
      },
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

  if (mentionTriggerMatched) {
    await sendToSlack(input.message, undefined, triggerMentions, 'Mention');
    logger.info(
      {
        messageId: discordCtx.messageId,
        guildId: discordCtx.guildId,
        triggerMentions,
      },
      'Forwarded Discord message via mention trigger',
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

  await sendToSlack(input.message, undefined, undefined, 'Rule');
  return { forwarded: true };
}
