export interface UnifiedMessage {
  platform: 'LINE' | 'Discord';
  sourceType: 'group' | 'dm' | 'channel';
  sourceName: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  sourceUrl?: string;
  attachmentUrls?: string[];
  raw?: unknown;
}

export interface DiscordRelayRule {
  id: string;
  name: string;
  enabled: boolean;
  sourceGuildId: string;
  sourceChannelId: string;
  targetSlackChannel: string;
  mentionTargets?: string[];
  excludedAuthorIds?: string[];
}

export interface DiscordSourceChannelOption {
  id: string;
  name: string;
  parentId?: string;
}

export interface DiscordSourceGuildOption {
  id: string;
  name: string;
  channels: DiscordSourceChannelOption[];
}
