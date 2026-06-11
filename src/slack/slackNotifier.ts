import { fetch } from 'undici';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { DEFAULT_SLACK_MESSAGE_TEMPLATE, getRelaySettings } from '../admin/relayRuleStore.js';
import type { SlackMentionIdentity, UnifiedMessage } from '../types.js';

function formatTimestamp(date: Date): string {
  return date.toLocaleString('zh-TW', {
    timeZone: config.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatPlatformLabel(platform: UnifiedMessage['platform']): string {
  if (platform === 'LINE') return '🟢 LINE';
  if (platform === 'Discord') return '🎮 Discord';
  return '🔗 Webhook';
}

// Server / group name (Discord splits "server::channel"; LINE/Webhook = sourceName).
function getServerName(msg: UnifiedMessage): string {
  if (msg.platform === 'Discord') {
    const [serverName] = msg.sourceName.split('::');
    return serverName ?? msg.sourceName;
  }
  return msg.sourceName;
}

// Channel with leading "#" for Discord; empty for LINE / Webhook (no channel).
function getChannelName(msg: UnifiedMessage): string {
  if (msg.platform === 'Discord') {
    const channelName = msg.sourceName.split('::')[1];
    return channelName ? `#${channelName}` : '';
  }
  return '';
}

// Combined 【平台】來源 #頻道 — kept for the legacy {source} placeholder.
function buildSourceLine(msg: UnifiedMessage): string {
  const platform = formatPlatformLabel(msg.platform);
  const channel = getChannelName(msg);
  return `【${platform}】${getServerName(msg)}${channel ? ` ${channel}` : ''}`;
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

function renderTemplate(template: string, vars: Record<string, string>): string {
  const entries = Object.entries(vars);
  const renderedLines: string[] = [];

  for (const rawLine of template.split('\n')) {
    let line = rawLine;
    let hadPlaceholder = false;
    for (const [key, value] of entries) {
      const token = `{${key}}`;
      if (line.includes(token)) {
        hadPlaceholder = true;
        line = line.split(token).join(value ?? '');
      }
    }
    if (hadPlaceholder) {
      // Trim trailing space left by an empty placeholder (e.g. {channel} on LINE).
      line = line.replace(/[ \t]+$/, '');
      // Drop a line that became blank *only* because its placeholder(s) resolved
      // to empty (e.g. a lone {mentions} line when there are no mentions).
      if (line.trim() === '') {
        continue;
      }
    }
    renderedLines.push(line);
  }

  return renderedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function buildSlackMessageText(
  msg: UnifiedMessage,
  mentionText: string,
  resolver: Map<string, string>,
  template: string,
): string {
  const annotatedContent = truncateSlackText(annotateContentMentions(msg, resolver), 2500);

  return renderTemplate(template || DEFAULT_SLACK_MESSAGE_TEMPLATE, {
    mentions: mentionText,
    sender: msg.senderName,
    content: annotatedContent,
    platform: formatPlatformLabel(msg.platform),
    server: getServerName(msg),
    channel: getChannelName(msg),
    link: msg.sourceUrl ?? '',
    time: formatTimestamp(msg.timestamp),
    // Legacy aliases (kept so previously-saved templates keep working).
    source: buildSourceLine(msg),
    sourceUrl: msg.sourceUrl ?? '',
  });
}

async function loadSlackRenderConfig(): Promise<{
  identities: SlackMentionIdentity[];
  template: string;
}> {
  try {
    const settings = await getRelaySettings();
    return {
      identities: settings.mentionDirectory?.identities ?? [],
      template: settings.slackMessageTemplate || DEFAULT_SLACK_MESSAGE_TEMPLATE,
    };
  } catch (err) {
    logger.warn({ err }, 'Unable to load Slack render config; using defaults');
    return { identities: [], template: DEFAULT_SLACK_MESSAGE_TEMPLATE };
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
  const renderConfig = await loadSlackRenderConfig();
  const resolver = buildMentionResolver(renderConfig.identities);
  const messageText = buildSlackMessageText(msg, mentionText, resolver, renderConfig.template);
  const targetChannel = channel ?? config.slack.defaultChannel;

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: messageText,
      },
    },
  ];

  // Slack block-kit buttons only accept http(s) URLs, so skip LINE's line:// deep link.
  const sourceUrl = String(msg.sourceUrl ?? '').trim();
  if (/^https?:\/\//i.test(sourceUrl)) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '開啟原始訊息',
            emoji: false,
          },
          url: sourceUrl,
        },
      ],
    });
  }

  const response = await fetch(SLACK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.slack.botToken}`,
    },
    body: JSON.stringify({
      channel: targetChannel,
      text: messageText,
      blocks,
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
