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
      : 'Channel';

  const lines: string[] = [
    '【外部訊息通知】',
    '',
    `平台：${msg.platform}`,
    `來源：${sourceLabel}`,
  ];

  if (msg.platform === 'LINE') {
    lines.push(`群組：${msg.sourceName}`);
  } else {
    const [serverName, channelName] = msg.sourceName.split('::');
    lines.push(`Server：${serverName ?? msg.sourceName}`);
    if (channelName) lines.push(`Channel：#${channelName}`);
  }

  lines.push(
    `發訊者：${msg.senderName}`,
    `時間：${formatTimestamp(msg.timestamp)}`,
    '',
    '內容：',
    msg.content,
    '',
    '狀態：未處理',
  );

  return lines.join('\n');
}

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';

export async function sendToSlack(
  msg: UnifiedMessage,
  channel?: string,
): Promise<void> {
  const text = buildSlackText(msg);
  const targetChannel = channel ?? config.slack.defaultChannel;

  const response = await fetch(SLACK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.slack.botToken}`,
    },
    body: JSON.stringify({ channel: targetChannel, text }),
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
    { platform: msg.platform, source: msg.sourceName, sender: msg.senderName, channel: targetChannel },
    'Forwarded message to Slack',
  );
}
