export interface UnifiedMessage {
  platform: 'LINE' | 'Discord' | 'Generic';
  sourceType: 'group' | 'dm' | 'channel';
  sourceName: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  sourceUrl?: string;
  attachmentUrls?: string[];
  mentionedExternalUserIds?: string[];
  raw?: unknown;
}

export interface DiscordMentionMapping {
  id: string;
  enabled: boolean;
  discordUserId: string;
  slackMention: string;
  label: string;
}

export interface LineMentionMapping {
  id: string;
  enabled: boolean;
  lineUserId: string;
  lineChannelId?: string;
  slackMention: string;
  label: string;
}

export interface DiscordMentionTriggerConfig {
  enabled: boolean;
  allowedGuildIds: string[];
  mappings: DiscordMentionMapping[];
}

export interface LineMentionTriggerConfig {
  enabled: boolean;
  allowedGroupIds: string[];
  excludedGroupIds: string[];
  mappings: LineMentionMapping[];
}

export interface SlackMentionIdentity {
  id: string;
  enabled: boolean;
  label: string;
  slackMention: string;
  discordUserIds: string[];
  lineUserIds: string[];
}

export interface MentionDirectoryConfig {
  identities: SlackMentionIdentity[];
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
  excludedAuthorRoleIds?: string[];
}

export interface LineRelayRule {
  id: string;
  name: string;
  enabled: boolean;
  sourceGroupId: string;
  targetSlackChannel: string;
  mentionTargets?: string[];
  excludedSpeakerIds?: string[];
}

export interface DiscordSourceChannelOption {
  id: string;
  name: string;
  parentId?: string;
}

export interface DiscordSourceRoleOption {
  id: string;
  name: string;
}

export interface DiscordSourceGuildOption {
  id: string;
  name: string;
  channels: DiscordSourceChannelOption[];
  roles: DiscordSourceRoleOption[];
}
