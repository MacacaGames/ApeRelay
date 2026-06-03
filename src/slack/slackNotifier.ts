import { fetch } from 'undici';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { UnifiedMessage } from '../types.js';

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

function buildSlackText(msg: UnifiedMessage): string {
  const sourceLabel =
    msg.platform === 'LINE'
      ? msg.sourceType === 'group'
        ? '群組'
        : '一對一'
      : msg.platform === 'Discord'
        ? 'Channel'
        : 'Webhook';

  const lines: string[] = [
    '【外部訊息通知】',
    '',
    `平台：${msg.platform}`,
    `來源：${sourceLabel}`,
  ];

  if (msg.platform === 'LINE') {
    lines.push(`群組：${msg.sourceName}`);
  } else if (msg.platform === 'Discord') {
    const [serverName, channelName] = msg.sourceName.split('::');
    lines.push(`Server：${serverName ?? msg.sourceName}`);
    if (channelName) lines.push(`Channel：#${channelName}`);
  } else {
    lines.push(`來源名稱：${msg.sourceName}`);
  }

  lines.push(
    `發訊者：${msg.senderName}`,
    `時間：${formatTimestamp(msg.timestamp)}`,
  );

  if (msg.sourceUrl) {
    lines.push(`來源連結：${msg.sourceUrl}`);
  }

  lines.push('', '內容：', msg.content, '', '狀態：未處理');

  return lines.join('\n');
}

function truncateSlackText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function mrkdwnField(label: string, value: string): Record<string, string> {
  return {
    type: 'mrkdwn',
    text: `*${label}*\n${truncateSlackText(value || '-', 900)}`,
  };
}

function buildSlackBlocks(msg: UnifiedMessage, mentionText: string) {
  const sourceLabel =
    msg.platform === 'LINE'
      ? msg.sourceType === 'group'
        ? '群組'
        : '一對一'
      : msg.platform === 'Discord'
        ? 'Channel'
        : 'Webhook';

  const fields = [
    mrkdwnField('平台', msg.platform),
    mrkdwnField('來源', sourceLabel),
  ];

  if (msg.platform === 'LINE') {
    fields.push(mrkdwnField('群組', msg.sourceName));
  } else if (msg.platform === 'Discord') {
    const [serverName, channelName] = msg.sourceName.split('::');
    fields.push(mrkdwnField('Server', serverName ?? msg.sourceName));
    if (channelName) {
      fields.push(mrkdwnField('Channel', `#${channelName}`));
    }
  } else {
    fields.push(mrkdwnField('來源名稱', msg.sourceName));
  }

  fields.push(mrkdwnField('發訊者', msg.senderName));
  fields.push(mrkdwnField('時間', formatTimestamp(msg.timestamp)));

  const blocks: Array<Record<string, unknown>> = [];

  if (mentionText) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${mentionText}\n*需要處理的新外部訊息*`,
      },
    });
  }

  blocks.push(
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '【外部訊息通知】',
        emoji: false,
      },
    },
    {
      type: 'section',
      fields,
    },
    {
      type: 'divider',
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*內容*\n${truncateSlackText(msg.content, 2800)}`,
      },
    },
  );

  if (msg.sourceUrl) {
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
          url: msg.sourceUrl,
        },
      ],
    });
  }

  blocks.push(
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: '*狀態*：`未處理`',
        },
      ],
    },
  );

  return blocks;
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
): Promise<void> {
  const normalizedMentionTargets = (mentionTargets ?? [])
    .map((value) => normalizeMentionTarget(value))
    .filter(Boolean);
  const mentionText = Array.from(new Set(normalizedMentionTargets)).join(' ');
  const messageText = buildSlackText(msg);
  const fallbackText = mentionText ? `${mentionText}\n\n${messageText}` : messageText;
  const targetChannel = channel ?? config.slack.defaultChannel;

  const response = await fetch(SLACK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.slack.botToken}`,
    },
    body: JSON.stringify({
      channel: targetChannel,
      text: fallbackText,
      blocks: buildSlackBlocks(msg, mentionText),
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
    },
    'Forwarded message to Slack',
  );
}
