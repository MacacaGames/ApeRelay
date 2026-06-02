import type {
  MessageEvent,
  TextEventMessage,
  WebhookEvent,
} from '@line/bot-sdk';
import type { UnifiedMessage } from '../types.js';

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

function getTextMessage(event: WebhookEvent): TextEventMessage | null {
  if (event.type !== 'message') {
    return null;
  }

  const msgEvent = event as MessageEvent;
  if (msgEvent.message.type !== 'text') {
    return null;
  }

  return msgEvent.message as TextEventMessage;
}

export function normalizeLineEvent(
  event: WebhookEvent,
  senderName?: string,
): UnifiedMessage | null {
  const textMessage = getTextMessage(event);
  if (!textMessage) {
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
    content: textMessage.text,
    timestamp,
    raw: event,
  };
}
