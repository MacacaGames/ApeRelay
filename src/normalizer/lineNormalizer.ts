import type { MessageEvent, WebhookEvent } from '@line/bot-sdk';
import type { MentionSpan, UnifiedMessage } from '../types.js';

type LineSourceType = 'group' | 'dm';
type LineSource = WebhookEvent['source'];

function getSourceType(source: LineSource): LineSourceType {
  return source.type === 'user' ? 'dm' : 'group';
}

function getSourceName(source: LineSource): string {
  if (source.type === 'group') {
    return `LINE 群組 (${source.groupId})`;
  }
  if (source.type === 'room') {
    return `LINE 房間 (${source.roomId})`;
  }
  return `LINE 使用者 (${source.userId ?? 'unknown'})`;
}

function getSenderId(source: LineSource): string {
  if (source.type === 'group' || source.type === 'room' || source.type === 'user') {
    return source.userId ?? 'unknown';
  }
  return 'unknown';
}

function getLineSourceUrl(source: LineSource): string {
  if (source.type === 'group' || source.type === 'room' || source.type === 'user') {
    return 'line://nv/chat';
  }
  return '';
}

function getMessageContent(event: WebhookEvent): string | null {
  if (event.type !== 'message') {
    return null;
  }

  const msgEvent = event as MessageEvent;
  if (msgEvent.message.type === 'text') {
    return msgEvent.message.text;
  }

  const messageType = msgEvent.message.type;
  if (messageType === 'image') return '[LINE 圖片訊息]';
  if (messageType === 'video') return '[LINE 影片訊息]';
  if (messageType === 'audio') return '[LINE 語音訊息]';
  if (messageType === 'file') return '[LINE 檔案訊息]';
  if (messageType === 'sticker') return '[LINE 貼圖訊息]';
  if (messageType === 'location') return '[LINE 位置訊息]';

  return '[LINE 非文字訊息]';
}

function getMentionedUserIds(event: WebhookEvent): string[] {
  if (event.type !== 'message') {
    return [];
  }

  const msgEvent = event as MessageEvent;
  if (msgEvent.message.type !== 'text') {
    return [];
  }

  const message = msgEvent.message as {
    mention?: {
      mentionees?: Array<{
        type?: string;
        userId?: string;
      }>;
    };
  };

  const mentionees = message.mention?.mentionees;
  if (!Array.isArray(mentionees)) {
    return [];
  }

  return mentionees
    .filter((item) => item.type === 'user' && typeof item.userId === 'string')
    .map((item) => String(item.userId).trim())
    .filter(Boolean);
}

function getMentionSpans(event: WebhookEvent): MentionSpan[] {
  if (event.type !== 'message') {
    return [];
  }

  const msgEvent = event as MessageEvent;
  if (msgEvent.message.type !== 'text') {
    return [];
  }

  const message = msgEvent.message as {
    mention?: {
      mentionees?: Array<{
        type?: string;
        userId?: string;
        index?: number;
        length?: number;
      }>;
    };
  };

  const mentionees = message.mention?.mentionees;
  if (!Array.isArray(mentionees)) {
    return [];
  }

  return mentionees
    .filter(
      (item) =>
        item.type === 'user' &&
        typeof item.userId === 'string' &&
        typeof item.index === 'number' &&
        typeof item.length === 'number',
    )
    .map((item) => ({
      index: item.index as number,
      length: item.length as number,
      externalUserId: String(item.userId).trim(),
    }))
    .filter((span) => Boolean(span.externalUserId));
}

export function normalizeLineEvent(
  event: WebhookEvent,
  senderName?: string,
): UnifiedMessage | null {
  const content = getMessageContent(event);
  if (!content) {
    return null;
  }

  const timestamp =
    typeof event.timestamp === 'number'
      ? new Date(event.timestamp)
      : new Date();

  return {
    platform: 'LINE',
    sourceType: getSourceType(event.source),
    sourceName: getSourceName(event.source),
    senderId: getSenderId(event.source),
    senderName: senderName ?? getSenderId(event.source),
    content,
    timestamp,
    sourceUrl: getLineSourceUrl(event.source),
    mentionedExternalUserIds: getMentionedUserIds(event),
    mentionSpans: getMentionSpans(event),
    raw: event,
  };
}
