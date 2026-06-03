import type { Message } from 'discord.js';
import type { UnifiedMessage } from '../types.js';

function toDate(timestamp: number): Date {
  return new Date(timestamp);
}

export function normalizeDiscordMessage(message: Message): UnifiedMessage | null {
  if (!message.guild || !message.channel || !('name' in message.channel)) {
    return null;
  }

  const textContent = message.content?.trim() ?? '';
  const attachmentUrls = message.attachments.map((attachment) => attachment.url);

  const hasImageAttachment = message.attachments.some((attachment) => {
    const contentType = attachment.contentType ?? '';
    return contentType.startsWith('image/');
  });

  const attachmentText = attachmentUrls.length
    ? ['附件：', ...attachmentUrls.map((url) => `- ${url}`)].join('\n')
    : '';

  let content = textContent;
  if (!content && hasImageAttachment) {
    content = '（圖片訊息）';
  }
  if (!content && attachmentUrls.length) {
    content = '（附件訊息）';
  }

  if (!content) {
    return null;
  }

  if (attachmentText) {
    content = `${content}\n\n${attachmentText}`;
  }

  const guildName = message.guild.name;
  const channelName = message.channel.name;
  const mentionedExternalUserIds = Array.from(message.mentions.users.keys());

  return {
    platform: 'Discord',
    sourceType: 'channel',
    sourceName: `${guildName}::${channelName}`,
    senderId: message.author.id,
    senderName: message.author.username,
    content,
    timestamp: toDate(message.createdTimestamp),
    sourceUrl: message.url,
    attachmentUrls,
    mentionedExternalUserIds,
    raw: {
      guildId: message.guild.id,
      channelId: message.channel.id,
      messageId: message.id,
    },
  };
}
