function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  if (!value) {
    return undefined;
  }
  return value;
}

function splitIds(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: parseInt(process.env['PORT'] ?? '3000', 10),
  publicBaseUrl: process.env['PUBLIC_BASE_URL'] ?? '',

  slack: {
    botToken: requireEnv('SLACK_BOT_TOKEN'),
    defaultChannel: requireEnv('SLACK_DEFAULT_CHANNEL'),
  },

  line: {
    channelSecret: optionalEnv('LINE_CHANNEL_SECRET'),
    channelAccessToken: optionalEnv('LINE_CHANNEL_ACCESS_TOKEN'),
    enabled: Boolean(
      optionalEnv('LINE_CHANNEL_SECRET') && optionalEnv('LINE_CHANNEL_ACCESS_TOKEN'),
    ),
  },

  discord: {
    botToken: requireEnv('DISCORD_BOT_TOKEN'),
    allowedGuildIds: splitIds(process.env['DISCORD_ALLOWED_GUILD_IDS'] ?? ''),
    allowedChannelIds: splitIds(process.env['DISCORD_ALLOWED_CHANNEL_IDS'] ?? ''),
  },

  timezone: process.env['TIMEZONE'] ?? 'Asia/Taipei',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
} as const;
