export interface UnifiedMessage {
  platform: 'LINE' | 'Discord';
  sourceType: 'group' | 'dm' | 'channel';
  sourceName: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  raw?: unknown;
}
