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

function isConfiguredSecret(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith('your_')) {
    return false;
  }

  return true;
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

  admin: {
    password: optionalEnv('ADMIN_PASSWORD'),
  },

  slack: {
    botToken: requireEnv('SLACK_BOT_TOKEN'),
    defaultChannel: requireEnv('SLACK_DEFAULT_CHANNEL'),
  },

  line: {
    channelSecret: optionalEnv('LINE_CHANNEL_SECRET'),
    channelAccessToken: optionalEnv('LINE_CHANNEL_ACCESS_TOKEN'),
    enabled: isConfiguredSecret(optionalEnv('LINE_CHANNEL_SECRET')) &&
      isConfiguredSecret(optionalEnv('LINE_CHANNEL_ACCESS_TOKEN')),
  },

  discord: {
    botToken: requireEnv('DISCORD_BOT_TOKEN'),
    allowedGuildIds: splitIds(process.env['DISCORD_ALLOWED_GUILD_IDS'] ?? ''),
    allowedChannelIds: splitIds(process.env['DISCORD_ALLOWED_CHANNEL_IDS'] ?? ''),
    excludedUserIds: splitIds(process.env['DISCORD_EXCLUDED_USER_IDS'] ?? ''),
  },

  timezone: process.env['TIMEZONE'] ?? 'Asia/Taipei',
  logLevel: process.env['LOG_LEVEL'] ?? 'info',
} as const;
