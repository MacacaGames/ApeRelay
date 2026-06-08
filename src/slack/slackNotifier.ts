import { fetch } from 'undici';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getMentionTriggerRuntimeConfig } from '../admin/relayRuleStore.js';
import type { SlackMentionIdentity, UnifiedMessage } from '../types.js';

function formatPlatformLabel(platform: UnifiedMessage['platform']): string {
  if (platform === 'LINE') return '🟢 LINE';
  if (platform === 'Discord') return '🎮 Discord';
  return '🔗 Webhook';
}

// 【平台】來源：頻道
function buildSourceLine(msg: UnifiedMessage): string {
  const platform = formatPlatformLabel(msg.platform);

  if (msg.platform === 'Discord') {
    const [serverName, channelName] = msg.sourceName.split('::');
    const server = serverName ?? msg.sourceName;
    const tail = channelName ? `${server}：#${channelName}` : server;
    return `【${platform}】${tail}`;
  }

  return `【${platform}】${msg.sourceName}`;
}

function truncateSlackText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

// externalUserId -> Slack mention, built from the Slack 身分主檔 (mention directory).
function buildMentionResolver(identities: SlackMentionIdentity[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const identity of identities) {
    if (!identity.enabled) {
      continue;
    }
    const mention = String(identity.slackMention || '').trim();
    if (!mention) {
      continue;
    }
    for (const id of [...(identity.discordUserIds ?? []), ...(identity.lineUserIds ?? [])]) {
      const key = String(id).trim();
      if (key && !map.has(key)) {
        map.set(key, mention);
      }
    }
  }
  return map;
}

// Tag mentioned people inside the message body with （<@Slack>）, resolved via
// the Slack 身分主檔. Discord <@id> tokens are replaced in place; LINE @names
// (located via mention spans) keep their text and get the tag appended.
function annotateContentMentions(msg: UnifiedMessage, resolver: Map<string, string>): string {
  let content = msg.content;
  if (resolver.size === 0) {
    return content;
  }

  const spans = msg.mentionSpans;
  if (Array.isArray(spans) && spans.length) {
    const ordered = [...spans]
      .filter((span) => span && typeof span.index === 'number' && typeof span.length === 'number')
      .sort((a, b) => b.index - a.index);
    for (const span of ordered) {
      const mention = resolver.get(String(span.externalUserId).trim());
      if (!mention) {
        continue;
      }
      const end = span.index + span.length;
      if (end > content.length) {
        continue;
      }
      content = `${content.slice(0, end)}（${mention}）${content.slice(end)}`;
    }
  }

  content = content.replace(/<@!?(\d+)>/g, (whole, id: string) => {
    const mention = resolver.get(String(id).trim());
    return mention ? `（${mention}）` : whole;
  });

  return content;
}

function buildSlackMessageText(
  msg: UnifiedMessage,
  mentionText: string,
  resolver: Map<string, string>,
): string {
  const annotatedContent = truncateSlackText(annotateContentMentions(msg, resolver), 2500);

  const lines: string[] = [];
  if (mentionText) {
    lines.push(mentionText);
  }
  lines.push(`發訊者：${msg.senderName}`);
  lines.push(`內容：${annotatedContent}`);
  lines.push('');
  lines.push(buildSourceLine(msg));

  return lines.join('\n');
}

async function loadMentionDirectoryIdentities(): Promise<SlackMentionIdentity[]> {
  try {
    const runtime = await getMentionTriggerRuntimeConfig();
    return runtime.mentionDirectory?.identities ?? [];
  } catch (err) {
    logger.warn({ err }, 'Unable to load mention directory for Slack content annotation');
    return [];
  }
}

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';

function normalizeMentionTarget(value: string): string {
  const raw = value.trim();
  if (!raw) return '';

  const lower = raw.toLowerCase();
  if (lower === '@everyone' || lower === '<!everyone>') return '<!everyone>';
  if (lower === '@here' || lower === '<!here>') return '<!here>';
  if (lower === '@channel' || lower === '<!channel>') return '<!channel>';

  const userMatch = raw.match(/^<@([A-Z0-9]+)>$/i);
  if (userMatch) {
    return `<@${userMatch[1].toUpperCase()}>`;
  }

  const userGroupWithLabelMatch = raw.match(/^<!subteam\^([A-Z0-9]+)(\|[^>]+)?>$/i);
  if (userGroupWithLabelMatch) {
    return `<!subteam^${userGroupWithLabelMatch[1].toUpperCase()}>`;
  }

  if (/^[SUW][A-Z0-9]{8,}$/i.test(raw)) {
    return `<@${raw.toUpperCase()}>`;
  }

  return raw;
}

export async function sendToSlack(
  msg: UnifiedMessage,
  channel?: string,
  mentionTargets?: string[],
  triggerReason = 'Rule',
): Promise<void> {
  const normalizedMentionTargets = (mentionTargets ?? [])
    .map((value) => normalizeMentionTarget(value))
    .filter(Boolean);
  const mentionText = Array.from(new Set(normalizedMentionTargets)).join(' ');
  const resolver = buildMentionResolver(await loadMentionDirectoryIdentities());
  const messageText = buildSlackMessageText(msg, mentionText, resolver);
  const targetChannel = channel ?? config.slack.defaultChannel;

  const response = await fetch(SLACK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.slack.botToken}`,
    },
    body: JSON.stringify({
      channel: targetChannel,
      text: messageText,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: messageText,
          },
        },
      ],
      mrkdwn: true,
      link_names: true,
      unfurl_links: false,
      unfurl_media: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    logger.error({ status: response.status, body }, 'Slack API HTTP error');
    throw new Error(`Slack API returned ${response.status}`);
  }

  // Slack API always returns 200 but may include ok:false in body
  const result = (await response.json()) as { ok: boolean; error?: string };
  if (!result.ok) {
    logger.error({ error: result.error, channel: targetChannel }, 'Slack API error');
    throw new Error(`Slack API error: ${result.error}`);
  }

  logger.info(
    {
      platform: msg.platform,
      source: msg.sourceName,
      sender: msg.senderName,
      channel: targetChannel,
      mentionTargets: mentionTargets ?? [],
      normalizedMentions: normalizedMentionTargets,
      triggerReason,
    },
    'Forwarded message to Slack',
  );
}
