import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import { fetch } from 'undici';
import {
  DEFAULT_SLACK_MESSAGE_TEMPLATE,
  createDiscordRelayRule,
  createLineRelayRule,
  deleteDiscordRelayRule,
  deleteLineRelayRule,
  exportRelayRules,
  getDiscordRelayRules,
  getLineRelayRules,
  getRelaySettings,
  importRelayRules,
  updateDiscordRelayRule,
  updateLineRelayRule,
  updateRelaySettings,
  type RelayRuleImportMode,
} from '../admin/relayRuleStore.js';
import { getDiscordRecentAuthorOptions, getDiscordSourceOptions } from '../discord/discordClient.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getLineRecentGroupOptions, getLineWebhookDebugState } from '../sources/lineSource.js';
import type {
  DiscordGlobalExcludedAuthorProfile,
  DiscordMentionMapping,
  DiscordMentionTriggerConfig,
  LineGlobalExcludedSpeakerProfile,
  MentionDirectoryConfig,
  DiscordRelayRule,
  LineMentionMapping,
  LineMentionTriggerConfig,
  LineRelayRule,
  SlackMentionIdentity,
} from '../types.js';

const router = Router();
const ADMIN_AUTH_COOKIE = 'ape_admin_auth';
const ADMIN_AUTH_MAX_AGE_SECONDS = 60 * 60 * 12;

type SlackChannelOption = { id: string; name: string };
type SlackUserOption = { id: string; displayName: string };
type SlackUserGroupOption = { id: string; handle: string; name: string };

function getCookieValue(cookieHeader: string | undefined, name: string): string {
  if (!cookieHeader) {
    return '';
  }

  const pair = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));

  if (!pair) {
    return '';
  }

  return decodeURIComponent(pair.slice(name.length + 1));
}

function getAdminCookiePayload(): string {
  if (!config.admin.password) {
    return '';
  }

  return crypto
    .createHash('sha256')
    .update(`${config.admin.password}:${config.slack.botToken}`)
    .digest('hex');
}

function isAdminAuthenticated(req: Request): boolean {
  if (!config.admin.password) {
    return true;
  }

  const cookie = getCookieValue(req.headers.cookie, ADMIN_AUTH_COOKIE);
  return cookie === getAdminCookiePayload();
}

function buildAdminCookie(maxAgeSeconds: number): string {
  const attrs = [
    `Max-Age=${maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];

  if (config.publicBaseUrl.startsWith('https://')) {
    attrs.push('Secure');
  }

  const value = maxAgeSeconds > 0 ? getAdminCookiePayload() : '';
  return `${ADMIN_AUTH_COOKIE}=${encodeURIComponent(value)}; ${attrs.join('; ')}`;
}

router.use((req, res, next) => {
  const authEnabled = Boolean(config.admin.password);
  if (!authEnabled) {
    next();
    return;
  }

  const path = req.path;
  const isAuthRoute =
    path === '/admin/login' ||
    path === '/api/admin/auth/login' ||
    path === '/api/admin/auth/logout' ||
    path === '/api/admin/auth/status';

  if (isAuthRoute) {
    next();
    return;
  }

  const isProtectedRoute = path === '/admin' || path.startsWith('/api/admin/');
  if (!isProtectedRoute) {
    next();
    return;
  }

  if (isAdminAuthenticated(req)) {
    next();
    return;
  }

  if (path.startsWith('/api/admin/')) {
    res.status(401).json({ ok: false, message: 'Unauthorized' });
    return;
  }

  res.redirect('/admin/login');
});

router.get('/admin/login', (req, res) => {
  if (!config.admin.password || isAdminAuthenticated(req)) {
    res.redirect('/admin');
    return;
  }

  res.type('html').send(`<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ApeRelay Admin Login</title>
    <style>
      :root {
        --bg: #f1f5f9;
        --card: #ffffff;
        --line: #e2e8f0;
        --text: #0f172a;
        --muted: #64748b;
        --brand: #0f766e;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: radial-gradient(circle at 20% -10%, #dbeafe 0%, transparent 35%), var(--bg);
        font-family: "Noto Sans TC", "PingFang TC", sans-serif;
        color: var(--text);
      }

      .card {
        width: min(92vw, 420px);
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 22px;
      }

      h1 { margin: 0; font-size: 22px; }

      p {
        margin: 8px 0 0;
        color: var(--muted);
        font-size: 14px;
      }

      form {
        display: grid;
        gap: 10px;
        margin-top: 16px;
      }

      input {
        width: 100%;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px 12px;
        font-size: 14px;
      }

      button {
        border: 0;
        border-radius: 10px;
        padding: 10px 12px;
        background: var(--brand);
        color: #fff;
        font-weight: 700;
        cursor: pointer;
      }

      .msg {
        min-height: 20px;
        color: #b91c1c;
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <section class="card">
      <h1>ApeRelay Admin</h1>
      <p>請輸入管理密碼</p>
      <form id="login-form">
        <input id="password" type="password" autocomplete="current-password" placeholder="Admin Password" required />
        <button type="submit">登入</button>
      </form>
      <div class="msg" id="message"></div>
    </section>

    <script>
      const form = document.getElementById('login-form');
      const passwordInput = document.getElementById('password');
      const messageEl = document.getElementById('message');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        messageEl.textContent = '';

        const res = await fetch('/api/admin/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: passwordInput.value }),
        });

        if (!res.ok) {
          messageEl.textContent = '密碼錯誤';
          return;
        }

        location.href = '/admin';
      });
    </script>
  </body>
</html>`);
});

router.post('/api/admin/auth/login', (req, res) => {
  if (!config.admin.password) {
    res.json({ ok: true, enabled: false });
    return;
  }

  const body = req.body as { password?: unknown };
  const input = typeof body.password === 'string' ? body.password : '';
  if (input !== config.admin.password) {
    res.status(401).json({ ok: false, message: 'Invalid password' });
    return;
  }

  res.setHeader('Set-Cookie', buildAdminCookie(ADMIN_AUTH_MAX_AGE_SECONDS));
  res.json({ ok: true });
});

router.post('/api/admin/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', buildAdminCookie(0));
  res.json({ ok: true });
});

router.get('/api/admin/auth/status', (req, res) => {
  res.json({
    ok: true,
    enabled: Boolean(config.admin.password),
    authenticated: isAdminAuthenticated(req),
  });
});

async function fetchSlackOptions(): Promise<{
  channels: SlackChannelOption[];
  users: SlackUserOption[];
  usergroups: SlackUserGroupOption[];
  errors: string[];
}> {
  const headers = {
    Authorization: `Bearer ${config.slack.botToken}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const channels: SlackChannelOption[] = [];
  const errors: string[] = [];
  let cursor = '';

  try {
    do {
      const query = new URLSearchParams({
        types: 'public_channel,private_channel',
        exclude_archived: 'true',
        limit: '200',
      });

      if (cursor) {
        query.set('cursor', cursor);
      }

      const res = await fetch(`https://slack.com/api/conversations.list?${query.toString()}`, {
        method: 'GET',
        headers,
      });

      const json = (await res.json()) as {
        ok: boolean;
        error?: string;
        channels?: Array<{ id: string; name: string }>;
        response_metadata?: { next_cursor?: string };
      };

      if (!json.ok) {
        logger.warn({ error: json.error }, 'Unable to fetch Slack channels for admin dropdown');
        errors.push(`channels: ${json.error ?? 'unknown_error'}`);
        break;
      }

      for (const item of json.channels ?? []) {
        channels.push({ id: item.id, name: item.name });
      }

      cursor = json.response_metadata?.next_cursor ?? '';
    } while (cursor);
  } catch (err) {
    logger.warn({ err }, 'Slack conversations.list request failed');
    errors.push('channels: request_failed');
  }

  const users: SlackUserOption[] = [];
  try {
    const res = await fetch('https://slack.com/api/users.list?limit=500', {
      method: 'GET',
      headers,
    });
    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
      members?: Array<{
        id: string;
        name: string;
        deleted?: boolean;
        is_bot?: boolean;
        profile?: { display_name?: string; real_name?: string };
      }>;
    };

    if (json.ok) {
      for (const member of json.members ?? []) {
        if (member.deleted || member.is_bot) {
          continue;
        }
        const displayName =
          member.profile?.display_name?.trim() ||
          member.profile?.real_name?.trim() ||
          member.name;
        if (displayName) {
          users.push({ id: member.id, displayName });
        }
      }
    } else {
      logger.warn({ error: json.error }, 'Unable to fetch Slack users for mention dropdown');
      errors.push(`users: ${json.error ?? 'unknown_error'}`);
    }
  } catch (err) {
    logger.warn({ err }, 'Slack users.list request failed');
    errors.push('users: request_failed');
  }

  const usergroups: SlackUserGroupOption[] = [];
  try {
    const res = await fetch('https://slack.com/api/usergroups.list?include_disabled=false', {
      method: 'GET',
      headers,
    });
    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
      usergroups?: Array<{ id: string; handle: string; name: string }>;
    };
    if (json.ok) {
      for (const group of json.usergroups ?? []) {
        usergroups.push({ id: group.id, handle: group.handle, name: group.name });
      }
    } else {
      logger.warn({ error: json.error }, 'Unable to fetch Slack usergroups for mention dropdown');
      errors.push(`usergroups: ${json.error ?? 'unknown_error'}`);
    }
  } catch (err) {
    logger.warn({ err }, 'Slack usergroups.list request failed');
    errors.push('usergroups: request_failed');
  }

  return { channels, users, usergroups, errors };
}

function parseDiscordRuleInput(input: Partial<DiscordRelayRule>): {
  payload?: Omit<DiscordRelayRule, 'id'>;
  missingFields: string[];
} {
  const payload: Omit<DiscordRelayRule, 'id'> = {
    name: String(input.name ?? '').trim(),
    enabled: Boolean(input.enabled ?? true),
    sourceGuildId: String(input.sourceGuildId ?? '').trim(),
    sourceChannelId: String(input.sourceChannelId ?? '').trim(),
    targetSlackChannel: String(input.targetSlackChannel ?? '').trim(),
    mentionTargets: Array.isArray(input.mentionTargets)
      ? input.mentionTargets.map((value) => String(value).trim()).filter(Boolean)
      : [],
    excludedAuthorIds: Array.isArray(input.excludedAuthorIds)
      ? input.excludedAuthorIds.map((value) => String(value).trim()).filter(Boolean)
      : [],
    excludedAuthorRoleIds: Array.isArray(input.excludedAuthorRoleIds)
      ? input.excludedAuthorRoleIds.map((value) => String(value).trim()).filter(Boolean)
      : [],
  };

  const missingFields: string[] = [];
  if (!payload.name) missingFields.push('規則名稱');
  if (!payload.sourceGuildId) missingFields.push('來源 Guild');
  if (!payload.targetSlackChannel) missingFields.push('目標 Slack 頻道');

  if (missingFields.length > 0) {
    return { missingFields };
  }

  return { payload, missingFields: [] };
}

function parseLineRuleInput(input: Partial<LineRelayRule>): {
  payload?: Omit<LineRelayRule, 'id'>;
  missingFields: string[];
} {
  const payload: Omit<LineRelayRule, 'id'> = {
    name: String(input.name ?? '').trim(),
    enabled: Boolean(input.enabled ?? true),
    sourceGroupId: String(input.sourceGroupId ?? '').trim(),
    targetSlackChannel: String(input.targetSlackChannel ?? '').trim(),
    mentionTargets: Array.isArray(input.mentionTargets)
      ? input.mentionTargets.map((value) => String(value).trim()).filter(Boolean)
      : [],
    excludedSpeakerIds: Array.isArray(input.excludedSpeakerIds)
      ? input.excludedSpeakerIds.map((value) => String(value).trim()).filter(Boolean)
      : [],
  };

  const missingFields: string[] = [];
  if (!payload.name) missingFields.push('規則名稱');
  if (!payload.sourceGroupId) missingFields.push('來源 LINE 群組');
  if (!payload.targetSlackChannel) missingFields.push('目標 Slack 頻道');

  if (missingFields.length > 0) {
    return { missingFields };
  }

  return { payload, missingFields: [] };
}

function parseDiscordMentionMappingInput(
  input: Partial<DiscordMentionMapping>,
): Omit<DiscordMentionMapping, 'id'> | null {
  if (!input.discordUserId || !input.slackMention) {
    return null;
  }

  return {
    enabled: Boolean(input.enabled ?? true),
    discordUserId: String(input.discordUserId).trim(),
    slackMention: String(input.slackMention).trim(),
    label: String(input.label ?? input.discordUserId).trim(),
  };
}

function parseLineMentionMappingInput(
  input: Partial<LineMentionMapping>,
): Omit<LineMentionMapping, 'id'> | null {
  if (!input.lineUserId || !input.slackMention) {
    return null;
  }

  return {
    enabled: Boolean(input.enabled ?? true),
    lineUserId: String(input.lineUserId).trim(),
    lineChannelId: String(input.lineChannelId ?? 'default').trim(),
    slackMention: String(input.slackMention).trim(),
    label: String(input.label ?? input.lineUserId).trim(),
  };
}

function parseSlackMentionIdentityInput(
  input: Partial<SlackMentionIdentity>,
): Omit<SlackMentionIdentity, 'id'> | null {
  if (!input.slackMention) {
    return null;
  }

  const discordUserIds = Array.isArray(input.discordUserIds)
    ? input.discordUserIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  const lineUserIds = Array.isArray(input.lineUserIds)
    ? input.lineUserIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  return {
    enabled: Boolean(input.enabled ?? true),
    label: String(input.label ?? input.slackMention).trim(),
    slackMention: String(input.slackMention).trim(),
    discordUserIds,
    lineUserIds,
  };
}

router.get('/api/admin/discord-sources', (_req, res) => {
  const sources = getDiscordSourceOptions();
  res.json({ ok: true, ...sources });
});

router.get('/api/admin/discord-authors', (req, res) => {
  const guildId = typeof req.query.guildId === 'string' ? req.query.guildId.trim() : '';
  const authors = getDiscordRecentAuthorOptions(guildId || undefined);
  res.json({ ok: true, authors });
});

router.get('/api/admin/line-sources', (_req, res) => {
  const groups = getLineRecentGroupOptions();
  res.json({ ok: true, groups });
});

router.get('/api/admin/line-debug', (_req, res) => {
  res.json({ ok: true, state: getLineWebhookDebugState() });
});

router.get('/api/admin/slack-options', async (_req, res) => {
  try {
    const options = await fetchSlackOptions();
    res.json({
      ok: true,
      ...options,
      loaded: {
        channels: options.channels.length,
        users: options.users.length,
        usergroups: options.usergroups.length,
      },
    });
  } catch (err) {
    logger.error({ err }, 'fetchSlackOptions unexpected error');
    res.json({ ok: true, channels: [], users: [], usergroups: [], errors: ['fetch_failed'], loaded: { channels: 0, users: 0, usergroups: 0 } });
  }
});

router.get('/api/admin/discord-rules', async (_req, res) => {
  const rules = await getDiscordRelayRules();
  res.json({ ok: true, rules });
});

router.get('/api/admin/line-rules', async (_req, res) => {
  const rules = await getLineRelayRules();
  res.json({ ok: true, rules });
});

router.get('/api/admin/settings', async (_req, res) => {
  const settings = await getRelaySettings();
  res.json({ ok: true, settings });
});

router.get('/api/admin/mention-trigger', async (_req, res) => {
  const settings = await getRelaySettings();
  res.json({
    ok: true,
    discordMentionTrigger: settings.discordMentionTrigger,
    lineMentionTrigger: settings.lineMentionTrigger,
    mentionDirectory: settings.mentionDirectory,
  });
});

router.put('/api/admin/mention-trigger/discord-scope', async (req, res) => {
  const body = req.body as Partial<DiscordMentionTriggerConfig>;
  const settings = await getRelaySettings();

  const patch: Partial<DiscordMentionTriggerConfig> = {};
  if (typeof body.enabled === 'boolean') {
    patch.enabled = body.enabled;
  }
  if (Array.isArray(body.allowedGuildIds)) {
    patch.allowedGuildIds = body.allowedGuildIds.map((value) => String(value).trim()).filter(Boolean);
  }

  const next = {
    ...settings.discordMentionTrigger,
    ...patch,
  };

  const updated = await updateRelaySettings({ discordMentionTrigger: next });
  res.json({ ok: true, discordMentionTrigger: updated.discordMentionTrigger });
});

router.put('/api/admin/mention-trigger/line-scope', async (req, res) => {
  const body = req.body as Partial<LineMentionTriggerConfig>;
  const settings = await getRelaySettings();

  const patch: Partial<LineMentionTriggerConfig> = {};
  if (typeof body.enabled === 'boolean') {
    patch.enabled = body.enabled;
  }
  if (Array.isArray(body.allowedGroupIds)) {
    patch.allowedGroupIds = body.allowedGroupIds.map((value) => String(value).trim()).filter(Boolean);
  }
  if (Array.isArray(body.excludedGroupIds)) {
    patch.excludedGroupIds = body.excludedGroupIds.map((value) => String(value).trim()).filter(Boolean);
  }

  const next = {
    ...settings.lineMentionTrigger,
    ...patch,
  };

  const updated = await updateRelaySettings({ lineMentionTrigger: next });
  res.json({ ok: true, lineMentionTrigger: updated.lineMentionTrigger });
});

router.post('/api/admin/mention-trigger/discord-mappings', async (req, res) => {
  const payload = parseDiscordMentionMappingInput(req.body as Partial<DiscordMentionMapping>);
  if (!payload) {
    res.status(400).json({ ok: false, message: 'Invalid Discord mention mapping payload.' });
    return;
  }

  const settings = await getRelaySettings();
  const nextMappings = settings.discordMentionTrigger.mappings.concat([{ id: crypto.randomUUID(), ...payload }]);
  const updated = await updateRelaySettings({
    discordMentionTrigger: {
      ...settings.discordMentionTrigger,
      mappings: nextMappings,
    },
  });

  res.status(201).json({ ok: true, discordMentionTrigger: updated.discordMentionTrigger });
});

router.put('/api/admin/mention-trigger/discord-mappings/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body as Partial<DiscordMentionMapping>;
  const settings = await getRelaySettings();
  const idx = settings.discordMentionTrigger.mappings.findIndex((item) => item.id === id);
  if (idx === -1) {
    res.status(404).json({ ok: false, message: 'Discord mention mapping not found.' });
    return;
  }

  const current = settings.discordMentionTrigger.mappings[idx];
  const nextItem: DiscordMentionMapping = {
    ...current,
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    ...(typeof body.discordUserId === 'string' ? { discordUserId: body.discordUserId.trim() } : {}),
    ...(typeof body.slackMention === 'string' ? { slackMention: body.slackMention.trim() } : {}),
    ...(typeof body.label === 'string' ? { label: body.label.trim() } : {}),
  };

  const nextMappings = [...settings.discordMentionTrigger.mappings];
  nextMappings[idx] = nextItem;

  const updated = await updateRelaySettings({
    discordMentionTrigger: {
      ...settings.discordMentionTrigger,
      mappings: nextMappings,
    },
  });

  res.json({ ok: true, discordMentionTrigger: updated.discordMentionTrigger });
});

router.delete('/api/admin/mention-trigger/discord-mappings/:id', async (req, res) => {
  const id = req.params.id;
  const settings = await getRelaySettings();
  const before = settings.discordMentionTrigger.mappings.length;
  const nextMappings = settings.discordMentionTrigger.mappings.filter((item) => item.id !== id);

  if (before === nextMappings.length) {
    res.status(404).json({ ok: false, message: 'Discord mention mapping not found.' });
    return;
  }

  const updated = await updateRelaySettings({
    discordMentionTrigger: {
      ...settings.discordMentionTrigger,
      mappings: nextMappings,
    },
  });

  res.json({ ok: true, discordMentionTrigger: updated.discordMentionTrigger });
});

router.post('/api/admin/mention-trigger/line-mappings', async (req, res) => {
  const payload = parseLineMentionMappingInput(req.body as Partial<LineMentionMapping>);
  if (!payload) {
    res.status(400).json({ ok: false, message: 'Invalid LINE mention mapping payload.' });
    return;
  }

  const settings = await getRelaySettings();
  const nextMappings = settings.lineMentionTrigger.mappings.concat([{ id: crypto.randomUUID(), ...payload }]);
  const updated = await updateRelaySettings({
    lineMentionTrigger: {
      ...settings.lineMentionTrigger,
      mappings: nextMappings,
    },
  });

  res.status(201).json({ ok: true, lineMentionTrigger: updated.lineMentionTrigger });
});

router.put('/api/admin/mention-trigger/line-mappings/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body as Partial<LineMentionMapping>;
  const settings = await getRelaySettings();
  const idx = settings.lineMentionTrigger.mappings.findIndex((item) => item.id === id);
  if (idx === -1) {
    res.status(404).json({ ok: false, message: 'LINE mention mapping not found.' });
    return;
  }

  const current = settings.lineMentionTrigger.mappings[idx];
  const nextItem: LineMentionMapping = {
    ...current,
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    ...(typeof body.lineUserId === 'string' ? { lineUserId: body.lineUserId.trim() } : {}),
    ...(typeof body.lineChannelId === 'string' ? { lineChannelId: body.lineChannelId.trim() } : {}),
    ...(typeof body.slackMention === 'string' ? { slackMention: body.slackMention.trim() } : {}),
    ...(typeof body.label === 'string' ? { label: body.label.trim() } : {}),
  };

  const nextMappings = [...settings.lineMentionTrigger.mappings];
  nextMappings[idx] = nextItem;

  const updated = await updateRelaySettings({
    lineMentionTrigger: {
      ...settings.lineMentionTrigger,
      mappings: nextMappings,
    },
  });

  res.json({ ok: true, lineMentionTrigger: updated.lineMentionTrigger });
});

router.delete('/api/admin/mention-trigger/line-mappings/:id', async (req, res) => {
  const id = req.params.id;
  const settings = await getRelaySettings();
  const before = settings.lineMentionTrigger.mappings.length;
  const nextMappings = settings.lineMentionTrigger.mappings.filter((item) => item.id !== id);

  if (before === nextMappings.length) {
    res.status(404).json({ ok: false, message: 'LINE mention mapping not found.' });
    return;
  }

  const updated = await updateRelaySettings({
    lineMentionTrigger: {
      ...settings.lineMentionTrigger,
      mappings: nextMappings,
    },
  });

  res.json({ ok: true, lineMentionTrigger: updated.lineMentionTrigger });
});

router.post('/api/admin/mention-directory/identities', async (req, res) => {
  const payload = parseSlackMentionIdentityInput(req.body as Partial<SlackMentionIdentity>);
  if (!payload) {
    res.status(400).json({ ok: false, message: 'Invalid mention identity payload.' });
    return;
  }

  const settings = await getRelaySettings();
  const nextIdentities = settings.mentionDirectory.identities.concat([{ id: crypto.randomUUID(), ...payload }]);
  const updated = await updateRelaySettings({
    mentionDirectory: {
      identities: nextIdentities,
    },
  });

  res.status(201).json({ ok: true, mentionDirectory: updated.mentionDirectory });
});

router.put('/api/admin/mention-directory/identities/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body as Partial<SlackMentionIdentity>;
  const settings = await getRelaySettings();
  const idx = settings.mentionDirectory.identities.findIndex((item) => item.id === id);
  if (idx === -1) {
    res.status(404).json({ ok: false, message: 'Mention identity not found.' });
    return;
  }

  const current = settings.mentionDirectory.identities[idx];
  const nextItem: SlackMentionIdentity = {
    ...current,
    ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
    ...(typeof body.label === 'string' ? { label: body.label.trim() } : {}),
    ...(typeof body.slackMention === 'string' ? { slackMention: body.slackMention.trim() } : {}),
    ...(Array.isArray(body.discordUserIds)
      ? { discordUserIds: body.discordUserIds.map((value) => String(value).trim()).filter(Boolean) }
      : {}),
    ...(Array.isArray(body.lineUserIds)
      ? { lineUserIds: body.lineUserIds.map((value) => String(value).trim()).filter(Boolean) }
      : {}),
  };

  const nextIdentities = [...settings.mentionDirectory.identities];
  nextIdentities[idx] = nextItem;

  const updated = await updateRelaySettings({
    mentionDirectory: {
      identities: nextIdentities,
    },
  });

  res.json({ ok: true, mentionDirectory: updated.mentionDirectory });
});

router.delete('/api/admin/mention-directory/identities/:id', async (req, res) => {
  const id = req.params.id;
  const settings = await getRelaySettings();
  const before = settings.mentionDirectory.identities.length;
  const nextIdentities = settings.mentionDirectory.identities.filter((item) => item.id !== id);

  if (before === nextIdentities.length) {
    res.status(404).json({ ok: false, message: 'Mention identity not found.' });
    return;
  }

  const updated = await updateRelaySettings({
    mentionDirectory: {
      identities: nextIdentities,
    },
  });

  res.json({ ok: true, mentionDirectory: updated.mentionDirectory });
});

router.put('/api/admin/mention-directory/bulk', async (req, res) => {
  const body = req.body as { identities?: Array<Partial<SlackMentionIdentity>> };
  if (!Array.isArray(body.identities)) {
    res.status(400).json({ ok: false, message: 'Invalid identities payload.' });
    return;
  }

  const normalized: SlackMentionIdentity[] = [];
  for (const raw of body.identities) {
    const parsed = parseSlackMentionIdentityInput(raw);
    if (!parsed) {
      res.status(400).json({ ok: false, message: 'Invalid identity item.' });
      return;
    }

    normalized.push({
      id: raw?.id ? String(raw.id) : crypto.randomUUID(),
      ...parsed,
    });
  }

  const updated = await updateRelaySettings({
    mentionDirectory: {
      identities: normalized,
    },
  });

  res.json({ ok: true, mentionDirectory: updated.mentionDirectory });
});

router.get('/api/admin/rules-export', async (_req, res) => {
  const data = await exportRelayRules();
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="ape-relay-rules-${date}.json"`);
  res.json(data);
});

router.post('/api/admin/rules-import', async (req, res) => {
  const body = req.body as { mode?: string; data?: unknown };
  const mode: RelayRuleImportMode = body.mode === 'replace' ? 'replace' : 'merge';
  const payload = body.data ?? body;

  try {
    const summary = await importRelayRules(payload, mode);
    res.json({ ok: true, mode, summary });
  } catch (err) {
    logger.warn({ err }, 'Unable to import relay rules');
    res.status(400).json({ ok: false, message: 'Invalid relay rule import file.' });
  }
});

router.put('/api/admin/settings', async (req, res) => {
  const body = req.body as {
    globalExcludedAuthorIds?: unknown;
    globalExcludedAuthorProfiles?: unknown;
    globalExcludedAuthorRoleIds?: unknown;
    globalExcludedLineSpeakerIds?: unknown;
    globalExcludedLineSpeakerProfiles?: unknown;
    slackMessageTemplate?: unknown;
  };

  const patch: {
    globalExcludedAuthorIds?: string[];
    globalExcludedAuthorProfiles?: DiscordGlobalExcludedAuthorProfile[];
    globalExcludedAuthorRoleIds?: string[];
    globalExcludedLineSpeakerIds?: string[];
    globalExcludedLineSpeakerProfiles?: LineGlobalExcludedSpeakerProfile[];
    slackMessageTemplate?: string;
  } = {};

  if (typeof body.slackMessageTemplate === 'string') {
    patch.slackMessageTemplate = body.slackMessageTemplate;
  }

  if (Array.isArray(body.globalExcludedAuthorIds)) {
    patch.globalExcludedAuthorIds = body.globalExcludedAuthorIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  if (Array.isArray(body.globalExcludedLineSpeakerIds)) {
    patch.globalExcludedLineSpeakerIds = body.globalExcludedLineSpeakerIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  if (Array.isArray(body.globalExcludedLineSpeakerProfiles)) {
    patch.globalExcludedLineSpeakerProfiles = body.globalExcludedLineSpeakerProfiles
      .map((item) => {
        const raw = item as Partial<LineGlobalExcludedSpeakerProfile> | null;
        const lineUserId = String(raw?.lineUserId ?? '').trim();
        if (!lineUserId) {
          return null;
        }

        const note = String(raw?.note ?? '').trim();
        const slackMention = String(raw?.slackMention ?? '').trim();
        return {
          lineUserId,
          note,
          slackMention: slackMention || undefined,
        };
      })
      .filter(Boolean) as LineGlobalExcludedSpeakerProfile[];
  }

  if (Array.isArray(body.globalExcludedAuthorProfiles)) {
    patch.globalExcludedAuthorProfiles = body.globalExcludedAuthorProfiles
      .map((item) => {
        const raw = item as Partial<DiscordGlobalExcludedAuthorProfile> | null;
        const discordUserId = String(raw?.discordUserId ?? '').trim();
        if (!discordUserId) {
          return null;
        }

        const note = String(raw?.note ?? '').trim();
        const slackMention = String(raw?.slackMention ?? '').trim();
        return {
          discordUserId,
          note,
          slackMention: slackMention || undefined,
        };
      })
      .filter(Boolean) as DiscordGlobalExcludedAuthorProfile[];
  }

  if (Array.isArray(body.globalExcludedAuthorRoleIds)) {
    patch.globalExcludedAuthorRoleIds = body.globalExcludedAuthorRoleIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  const settings = await updateRelaySettings(patch);
  res.json({ ok: true, settings });
});

router.post('/api/admin/discord-rules', async (req, res) => {
  const parsed = parseDiscordRuleInput(req.body as Partial<DiscordRelayRule>);
  if (!parsed.payload) {
    res.status(400).json({
      ok: false,
      message: `缺少必要欄位：${parsed.missingFields.join('、')}`,
      missingFields: parsed.missingFields,
    });
    return;
  }

  const created = await createDiscordRelayRule(parsed.payload);
  res.status(201).json({ ok: true, rule: created });
});

router.put('/api/admin/discord-rules/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body as Partial<DiscordRelayRule>;

  const patch: Partial<Omit<DiscordRelayRule, 'id'>> = {};
  if (typeof body.name === 'string') patch.name = body.name.trim();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.sourceGuildId === 'string') patch.sourceGuildId = body.sourceGuildId.trim();
  if (typeof body.sourceChannelId === 'string') patch.sourceChannelId = body.sourceChannelId.trim();
  if (typeof body.targetSlackChannel === 'string') patch.targetSlackChannel = body.targetSlackChannel.trim();
  if (Array.isArray(body.mentionTargets)) {
    patch.mentionTargets = body.mentionTargets
      .map((value) => String(value).trim())
      .filter(Boolean);
  }
  if (Array.isArray(body.excludedAuthorIds)) {
    patch.excludedAuthorIds = body.excludedAuthorIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }
  if (Array.isArray(body.excludedAuthorRoleIds)) {
    patch.excludedAuthorRoleIds = body.excludedAuthorRoleIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  const updated = await updateDiscordRelayRule(id, patch);
  if (!updated) {
    res.status(404).json({ ok: false, message: 'Rule not found.' });
    return;
  }

  res.json({ ok: true, rule: updated });
});

router.delete('/api/admin/discord-rules/:id', async (req, res) => {
  const id = req.params.id;
  const deleted = await deleteDiscordRelayRule(id);
  if (!deleted) {
    res.status(404).json({ ok: false, message: 'Rule not found.' });
    return;
  }

  res.json({ ok: true });
});

router.post('/api/admin/line-rules', async (req, res) => {
  const parsed = parseLineRuleInput(req.body as Partial<LineRelayRule>);
  if (!parsed.payload) {
    res.status(400).json({
      ok: false,
      message: `缺少必要欄位：${parsed.missingFields.join('、')}`,
      missingFields: parsed.missingFields,
    });
    return;
  }

  const created = await createLineRelayRule(parsed.payload);
  res.status(201).json({ ok: true, rule: created });
});

router.put('/api/admin/line-rules/:id', async (req, res) => {
  const id = req.params.id;
  const body = req.body as Partial<LineRelayRule>;

  const patch: Partial<Omit<LineRelayRule, 'id'>> = {};
  if (typeof body.name === 'string') patch.name = body.name.trim();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.sourceGroupId === 'string') patch.sourceGroupId = body.sourceGroupId.trim();
  if (typeof body.targetSlackChannel === 'string') patch.targetSlackChannel = body.targetSlackChannel.trim();
  if (Array.isArray(body.mentionTargets)) {
    patch.mentionTargets = body.mentionTargets
      .map((value) => String(value).trim())
      .filter(Boolean);
  }
  if (Array.isArray(body.excludedSpeakerIds)) {
    patch.excludedSpeakerIds = body.excludedSpeakerIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  const updated = await updateLineRelayRule(id, patch);
  if (!updated) {
    res.status(404).json({ ok: false, message: 'Rule not found.' });
    return;
  }

  res.json({ ok: true, rule: updated });
});

router.delete('/api/admin/line-rules/:id', async (req, res) => {
  const id = req.params.id;
  const deleted = await deleteLineRelayRule(id);
  if (!deleted) {
    res.status(404).json({ ok: false, message: 'Rule not found.' });
    return;
  }

  res.json({ ok: true });
});

router.get('/admin', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ApeRelay Admin</title>
    <style>
      :root {
        --bg: #f1f5f9;
        --card: #ffffff;
        --muted: #64748b;
        --line: #e2e8f0;
        --text: #0f172a;
        --brand: #0f766e;
        --brand-strong: #115e59;
        --slack-bg: #fff8e7;
        --slack-line: #f59e0b;
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        font-family: "Noto Sans TC", "PingFang TC", sans-serif;
        color: var(--text);
        background: radial-gradient(circle at 10% -10%, #dbeafe 0%, transparent 35%), var(--bg);
      }

      .wrap {
        max-width: 1200px;
        margin: 0 auto;
        padding: 24px;
      }

      h1 { margin: 0; }
      h2, h3 { margin: 0 0 10px; }
      p { margin: 0; }

      .lead {
        color: var(--muted);
        margin-top: 6px;
      }

      .card {
        background: var(--card);
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 16px;
        margin-top: 16px;
      }

      .slack-card {
        background: linear-gradient(140deg, var(--slack-bg), #fff);
        border: 2px solid var(--slack-line);
      }

      .slack-title {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 8px;
      }

      .chip {
        display: inline-block;
        border-radius: 999px;
        padding: 3px 10px;
        font-size: 12px;
        background: #fee2e2;
        color: #991b1b;
      }

      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 12px;
      }

      .kv {
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px;
      }

      .kv .k {
        font-size: 12px;
        color: var(--muted);
      }

      .kv .v {
        margin-top: 2px;
        font-weight: 700;
      }

      .tabs {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      .tab-btn {
        border: 1px solid var(--line);
        background: #fff;
        color: #0f172a;
        border-radius: 10px;
        padding: 8px 12px;
        cursor: pointer;
        font-weight: 600;
      }

      .tab-btn.active {
        border-color: var(--brand);
        background: #ecfeff;
        color: #134e4a;
      }

      .tab-panel { display: none; }
      .tab-panel.active { display: block; }

      label {
        display: block;
        margin: 10px 0 4px;
        font-size: 14px;
        color: #334155;
      }

      input, select {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 8px 10px;
        background: #fff;
      }

      textarea {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        padding: 10px 12px;
        background: #fff;
        font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
        font-size: 13px;
        line-height: 1.5;
        resize: vertical;
      }

      input[type="checkbox"] { width: auto; }

      .row {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
      }

      .flow-block {
        border: 1px dashed #cbd5e1;
        border-radius: 12px;
        padding: 12px;
        margin-top: 12px;
        background: #fcfdff;
      }

      .flow-title {
        font-size: 13px;
        font-weight: 700;
        color: #334155;
      }

      .actions {
        margin-top: 12px;
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }

      button {
        border: 0;
        border-radius: 8px;
        padding: 8px 12px;
        background: var(--brand);
        color: #fff;
        cursor: pointer;
      }

      button.secondary { background: #475569; }
      button.ghost {
        background: #fff;
        border: 1px solid #cbd5e1;
        color: #0f172a;
      }

      .hint { font-size: 13px; color: var(--muted); margin-top: 6px; }
      .warn { font-size: 13px; color: #b45309; margin-top: 6px; }

      table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      th, td {
        text-align: left;
        border-bottom: 1px solid var(--line);
        padding: 8px;
        font-size: 14px;
        vertical-align: top;
      }

      .rules-table {
        table-layout: fixed;
      }

      .rules-table th:nth-child(1),
      .rules-table td:nth-child(1) { width: 78px; }
      .rules-table th:nth-child(2),
      .rules-table td:nth-child(2) { width: 92px; }
      .rules-table th:nth-child(7),
      .rules-table td:nth-child(7) { width: 62px; }
      .rules-table th:nth-child(8),
      .rules-table td:nth-child(8) { width: 82px; }

      .cell-stack {
        display: grid;
        gap: 6px;
        min-width: 0;
      }

      .cell-line {
        display: grid;
        gap: 2px;
        min-width: 0;
      }

      .cell-label {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.2;
      }

      .cell-value {
        color: var(--text);
        line-height: 1.35;
        overflow-wrap: anywhere;
        word-break: break-word;
      }

      .mention-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .mention-pill {
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        border-radius: 999px;
        padding: 3px 8px;
        max-width: 100%;
        overflow-wrap: anywhere;
      }

      .global-excluded-editor {
        margin-top: 10px;
        border: 1px solid var(--line);
        border-radius: 10px;
        background: #fcfdff;
      }

      .global-excluded-editor summary {
        cursor: pointer;
        padding: 10px 12px;
        color: #334155;
        font-weight: 600;
      }

      .global-excluded-editor-body {
        padding: 0 12px 12px;
      }

      .global-excluded-table {
        table-layout: fixed;
      }

      .global-excluded-table th:nth-child(1),
      .global-excluded-table td:nth-child(1) { width: 30%; }
      .global-excluded-table th:nth-child(4),
      .global-excluded-table td:nth-child(4) { width: 80px; }

      .global-excluded-table input,
      .global-excluded-table select {
        margin: 0;
      }

      .mini-label {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.1;
        margin-bottom: 4px;
      }

      .table-actions {
        display: grid;
        gap: 6px;
      }

      .platform-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 34px;
        min-height: 34px;
        border-radius: 999px;
        border: 1px solid #cbd5e1;
        background: #f8fafc;
        font-size: 20px;
      }

      .platform-badge.line {
        background: #ecfdf5;
        border-color: #86efac;
      }

      .platform-badge.discord {
        background: #eef2ff;
        border-color: #c7d2fe;
      }

      .rule-transfer {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        margin-top: 12px;
      }

      .rule-transfer select {
        width: auto;
        min-width: 120px;
      }

      .file-input {
        width: auto;
        max-width: 320px;
      }

      .mapping-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 10px;
      }

      .mapping-grid .full {
        grid-column: 1 / -1;
      }

      .mini-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 12px;
        background: #f8fafc;
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 10px;
      }

      @media (max-width: 900px) {
        .grid, .row { grid-template-columns: 1fr; }
        .mapping-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <h1>ApeRelay Admin</h1>
      <p class="lead">規則流程採用「先來源，再目標」。來源與目標各自獨立設定，不再混雜。</p>

    

      <section class="card">
        <h2>規則總覽（共享）</h2>
        <p class="hint">這裡顯示全部來源規則（Discord + LINE）。可直接在這裡啟用/停用、編輯、刪除。</p>
        <div class="rule-transfer">
          <button id="exportRulesBtn" class="ghost" type="button">匯出全部規則</button>
          <select id="importRulesMode" aria-label="匯入模式">
            <option value="merge">匯入並合併新增</option>
            <option value="replace">匯入並覆蓋全部</option>
          </select>
          <input id="importRulesFile" class="file-input" type="file" accept="application/json,.json" />
          <button id="importRulesBtn" class="secondary" type="button">匯入規則</button>
        </div>
        <div id="ruleTransferStatus" class="hint"></div>
        <table class="rules-table">
          <thead>
            <tr>
              <th>平台</th>
              <th>規則名稱</th>
              <th>來源</th>
              <th>目標</th>
              <th>通知對象</th>
              <th>來源篩選</th>
              <th>啟用</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody id="sharedRuleRows"></tbody>
        </table>
      </section>

      <section class="card">
        <h2>Slack 訊息格式（全域模板）</h2>
        <p class="hint">編輯轉發到 Slack 的訊息版型，存檔即時生效（不需重新部署）。Discord / LINE / Webhook 共用此模板。</p>
        <p class="hint">可用變數：
          <code>{platform}</code> 平台（🎮 Discord / 🟢 LINE）、
          <code>{server}</code> 伺服器/群組名、
          <code>{channel}</code> 頻道（Discord 為 #頻道；LINE 為空）、
          <code>{sender}</code> 發訊者、
          <code>{content}</code> 內容（含標記對象）、
          <code>{mentions}</code> 通知對象、
          <code>{time}</code> 時間、
          <code>{link}</code> 原始連結。
          空白的變數該行會自動省略。</p>
        <textarea id="slackMessageTemplate" rows="8" spellcheck="false" placeholder="訊息模板"></textarea>
        <div class="actions">
          <button id="saveSlackTemplateBtn" type="button">儲存訊息格式</button>
          <button id="resetSlackTemplateBtn" class="ghost" type="button">還原預設</button>
        </div>
        <div id="slackTemplateStatus" class="hint"></div>
      </section>

      <section class="card">
        <div class="tabs" id="tabNav">
          <button class="tab-btn active" data-tab="discord">🎮 Discord 規則</button>
          <button class="tab-btn" data-tab="line">🟢 LINE 規則</button>
          <button class="tab-btn" data-tab="mention">🔔 Mention Trigger</button>
          <button class="tab-btn" data-tab="diag">診斷</button>
        </div>
      </section>

      <section id="tab-discord" class="tab-panel active">
        <div class="card">
          <h2>Discord 全域排除作者</h2>
          <p class="hint">會和每條 Discord 規則的排除名單 union，執行期即時生效。</p>
          <label>Discord User ID（多個用逗號分隔）</label>
          <input id="globalExcludedAuthorIds" placeholder="例如 123456789012345678, 987654321098765432" />
          <details class="global-excluded-editor" open>
            <summary>展開 ID 名稱備註與 Slack 連結</summary>
            <div class="global-excluded-editor-body">
              <p class="hint">可直接為每個 ID 填備註，或指定對應 Slack 成員。若 Mention Directory 已有映射，會自動帶入名稱。</p>
              <div class="actions" style="margin-top:8px;">
                <button id="syncGlobalExcludedAuthorRowsBtn" class="ghost" type="button">由 ID 欄同步展開列表</button>
              </div>
              <table class="global-excluded-table">
                <thead>
                  <tr>
                    <th>Discord User ID</th>
                    <th>名稱備註</th>
                    <th>Slack Mention Trigger</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody id="globalExcludedAuthorRows"></tbody>
              </table>
            </div>
          </details>
          <label>從近期作者加入（可多選）</label>
          <select id="globalExcludedAuthorSelect" multiple size="6"></select>
          <label>Discord Role ID（多個用逗號分隔）</label>
          <input id="globalExcludedAuthorRoleIds" placeholder="例如 123456789012345678, 987654321098765432" />
          <label>從角色清單加入（可多選）</label>
          <select id="globalExcludedAuthorRoleSelect" multiple size="6"></select>
          <div class="actions">
            <button id="addGlobalExcludedAuthorBtn" class="secondary">加入到全域排除</button>
            <button id="addGlobalExcludedAuthorRoleBtn" class="secondary">加入到全域排除角色</button>
            <button id="saveGlobalSettingsBtn">儲存全域設定</button>
          </div>
          <div id="globalSettingsStatus" class="hint"></div>
        </div>

        <div class="card">
          <h2>新增/編輯 Discord 規則</h2>

          <label>規則名稱</label>
          <input id="discordName" placeholder="例如：Parco Discord → #parco-alert" />

          <div class="flow-block">
            <div class="flow-title">Step 1. 來源設定（Source）</div>
            <div class="actions">
              <button id="refreshDiscordSourcesBtn" class="ghost" type="button">更新 Discord Guild/Channel</button>
            </div>
            <div id="discordSourceStatus" class="hint"></div>
            <div class="row">
              <div>
                <label>Discord Guild（可下拉）</label>
                <select id="guildSelect"><option value="">手動輸入</option></select>
                <input id="guildId" placeholder="838735527204093962" />
              </div>
              <div>
                <label>Discord Channel（可下拉；留空代表該 Guild 全部 Channel）</label>
                <select id="channelSelect"><option value="">全部 Channel（Guild-wide）</option></select>
                <input id="channelId" placeholder="留空=全部；或輸入 838741333845737503" />
              </div>
            </div>

            <label>排除轉發作者（Discord User ID，多個用逗號分隔）</label>
            <input id="excludedAuthorIds" placeholder="例如 123456789012345678, 987654321098765432" />
            <label>從近期作者加入（可多選）</label>
            <select id="excludedAuthorSelect" multiple size="6"></select>
            <label>排除轉發身份組（Discord Role ID，多個用逗號分隔）</label>
            <input id="excludedAuthorRoleIds" placeholder="例如 123456789012345678, 987654321098765432" />
            <label>從角色清單加入（可多選）</label>
            <select id="excludedAuthorRoleSelect" multiple size="6"></select>

            <div class="actions">
              <button id="addExcludedAuthorBtn" class="secondary">加入到規則排除</button>
              <button id="addExcludedAuthorRoleBtn" class="secondary">加入到規則排除角色</button>
            </div>
          </div>

          <div class="flow-block">
            <div class="flow-title">Step 2. 目標設定（Target）</div>
            <label>Slack 目標頻道（#name 或 C123...）</label>
            <select id="discordSlackChannelSelect"><option value="">手動輸入</option></select>
            <input id="discordSlackChannel" placeholder="#封存-programmer" />

            <label>預設標記對象（可多選）</label>
            <select id="discordMentionTargets" multiple size="6"></select>
            <input id="discordMentionsCustom" placeholder="額外自訂標記，多個用逗號分隔，例如 <@U12345>, <@U99999>" style="margin-top:8px;" />
          </div>

          <label><input id="discordEnabled" type="checkbox" checked /> 啟用</label>
          <div class="actions">
            <button id="saveDiscordRuleBtn">建立規則</button>
            <button id="cancelDiscordEditBtn" class="secondary" style="display:none;">取消編輯</button>
          </div>
        </div>

      </section>

      <section id="tab-line" class="tab-panel">
        <div class="card">
          <h2>LINE 全域排除發言者</h2>
          <p class="hint">會和每條 LINE 規則的排除名單 union，執行期即時生效。</p>
          <label>LINE User ID（多個用逗號分隔）</label>
          <input id="globalExcludedLineSpeakerIds" placeholder="例如 U123abc..., U999xyz..." />
          <details class="global-excluded-editor" open>
            <summary>展開 ID 名稱備註與 Slack 連結</summary>
            <div class="global-excluded-editor-body">
              <p class="hint">可直接為每個 ID 填備註，或指定對應 Slack 成員。若 Mention Directory 已有映射，會自動帶入名稱；指定後儲存會同步回 Slack 身分主檔。</p>
              <div class="actions" style="margin-top:8px;">
                <button id="syncGlobalExcludedLineSpeakerRowsBtn" class="ghost" type="button">由 ID 欄同步展開列表</button>
              </div>
              <table class="global-excluded-table">
                <thead>
                  <tr>
                    <th>LINE User ID</th>
                    <th>名稱備註</th>
                    <th>Slack Mention Trigger</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody id="globalExcludedLineSpeakerRows"></tbody>
              </table>
            </div>
          </details>
          <label>從最近發言者加入（可多選）</label>
          <select id="globalLineExcludedSpeakerSelect" multiple size="6"></select>
          <div class="actions">
            <button id="addGlobalLineExcludedSpeakerBtn" class="secondary">加入到 LINE 全域排除</button>
            <button id="saveLineGlobalSettingsBtn">儲存 LINE 全域設定</button>
          </div>
          <div id="lineGlobalSettingsStatus" class="hint"></div>
        </div>

        <div class="card">
          <h2>新增/編輯 LINE 規則</h2>
          <p class="hint">流程同樣是先來源、再目標。可直接從最近收到訊息的群組建立來源。</p>

          <label>規則名稱</label>
          <input id="lineName" placeholder="例如：LINE 客戶群 A → #support-line" />

          <div class="flow-block">
            <div class="flow-title">Step 1. 來源設定（Source）</div>
            <label>最近收到的 LINE 群組</label>
            <select id="lineGroupSelect"><option value="">請選擇群組</option></select>
            <input id="lineGroupId" placeholder="groupId（可手動貼上）" />
            <div id="lineGroupStatus" class="hint"></div>

            <label>預設排除對象（LINE userId，多個用逗號分隔；留空代表不排除）</label>
            <input id="lineExcludedSpeakerIds" placeholder="例如 U123abc..., U999xyz..." />
            <label>從最近發言者加入（可多選）</label>
            <select id="lineSpeakerSelect" multiple size="6"></select>
            <div class="actions">
              <button id="addLineSpeakerBtn" class="secondary">加入到規則排除</button>
              <button id="refreshLineSourcesBtn" class="ghost">更新最近 LINE 群組/發言者</button>
            </div>
          </div>

          <div class="flow-block">
            <div class="flow-title">Step 2. 目標設定（Target）</div>
            <label>Slack 目標頻道（#name 或 C123...）</label>
            <select id="lineSlackChannelSelect"><option value="">手動輸入</option></select>
            <input id="lineSlackChannel" placeholder="#封存-programmer" />

            <label>預設標記對象（可多選）</label>
            <select id="lineMentionTargets" multiple size="6"></select>
            <input id="lineMentionsCustom" placeholder="額外自訂標記，多個用逗號分隔，例如 <@U12345>, <!subteam^S1234>" style="margin-top:8px;" />
          </div>

          <label><input id="lineEnabled" type="checkbox" checked /> 啟用</label>
          <div class="actions">
            <button id="saveLineRuleBtn">建立規則</button>
            <button id="cancelLineEditBtn" class="secondary" style="display:none;">取消編輯</button>
          </div>
        </div>

      </section>

      <section id="tab-mention" class="tab-panel">
        <div class="card">
          <h2>Mention Trigger 觸發範圍</h2>
          <p class="hint">觸發條件依平台獨立；實際要通知誰由下方「Slack 身分主檔」統一管理。</p>

          <div class="row">
            <div>
              <label><input id="mentionDiscordEnabled" type="checkbox" /> 啟用 Discord Mention Trigger</label>
              <label>Discord Allowed Guild IDs（逗號分隔；留空代表不限）</label>
              <input id="mentionDiscordAllowedGuildIds" placeholder="例如 838735527204093962, 123456789012345678" />
              <div class="actions">
                <button id="saveDiscordMentionScopeBtn" type="button">儲存 Discord 觸發範圍</button>
              </div>
            </div>

            <div>
              <label><input id="mentionLineEnabled" type="checkbox" /> 啟用 LINE Mention Trigger</label>
              <label>LINE Allowed Group IDs（逗號分隔；留空代表不限）</label>
              <input id="mentionLineAllowedGroupIds" placeholder="例如 Cb8e39304a4f97d49b08a2186061cc69b" />
              <label>LINE Excluded Group IDs（逗號分隔）</label>
              <input id="mentionLineExcludedGroupIds" placeholder="例如 Cxxxxxxxxxxxx" />
              <div class="actions">
                <button id="saveLineMentionScopeBtn" type="button">儲存 LINE 觸發範圍</button>
              </div>
            </div>
          </div>
        </div>

        <div class="card">
          <h2>Slack 身分主檔（1 Slack → 多平台 UID）</h2>
          <p class="hint">自動抓 Slack 成員清單建立主表，直接在欄位填 Discord / LINE UID，整批儲存。</p>
          <div class="flow-block">
            <div class="flow-title">Slack 成員映射表（批次）</div>

            <div class="actions">
              <button id="refreshMentionIdentityFromSlackBtn" class="ghost" type="button">重新同步 Slack 成員</button>
              <button id="selectAllMentionIdentityRowsBtn" class="secondary" type="button">全選列</button>
              <button id="clearMentionIdentityRowsSelectionBtn" class="secondary" type="button">清空列選取</button>
              <button id="saveMentionIdentityBulkBtn" type="button">整批儲存映射</button>
            </div>

            <div class="row">
              <div>
                <label>近期 Discord 作者 UID（可多選）</label>
                <select id="mentionIdentityDiscordRecentSelect" multiple size="6"></select>
                <div class="actions">
                  <button id="addMentionIdentityDiscordRecentBtn" class="secondary" type="button">加入到勾選列的 Discord 欄</button>
                </div>
              </div>
              <div>
                <label>近期 LINE 發言者 UID（可多選）</label>
                <select id="mentionIdentityLineRecentSelect" multiple size="6"></select>
                <div class="actions">
                  <button id="addMentionIdentityLineRecentBtn" class="secondary" type="button">加入到勾選列的 LINE 欄</button>
                </div>
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>套用</th>
                  <th>Slack 成員</th>
                  <th>Slack Mention</th>
                  <th>Discord UIDs</th>
                  <th>LINE UIDs</th>
                  <th>啟用</th>
                </tr>
              </thead>
              <tbody id="mentionIdentityRows"></tbody>
            </table>
          </div>
          <div id="mentionIdentityStatus" class="hint"></div>
        </div>

        <div class="card">
          <h2>舊版映射（相容）</h2>
          <p class="hint">為了向後相容，舊版 Discord/LINE mapping 仍可讀取；新設定請以上方主檔為主。</p>
          <div class="flow-block">
            <table>
              <thead>
                <tr>
                  <th>來源</th>
                  <th>UID</th>
                  <th>Slack Mention</th>
                  <th>啟用</th>
                </tr>
              </thead>
              <tbody id="legacyMentionMappingRows"></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="tab-diag" class="tab-panel">
        <div class="card">
          <h2>LINE Webhook 診斷</h2>
          <p class="hint">確認 verify / event / relay 是否成功。</p>
          <div class="actions">
            <button id="refreshLineDebugBtn" class="ghost">更新診斷資料</button>
          </div>
          <pre id="lineDebugDump">(loading...)</pre>
        </div>
      </section>
        <section class="card slack-card">
        <div class="slack-title">
          <h2>目標資源（Slack）候選池</h2>
          <span class="chip">非規則本體</span>
        </div>
        <p class="hint">這裡只負責載入可選目標（頻道/標記對象）。真正要送去哪裡，仍在每一條規則的「目標設定」內決定。</p>

        <div class="grid">
          <div class="kv">
            <div class="k">ENV 預設頻道</div>
            <div class="v" id="slackDefaultChannel">-</div>
          </div>
          <div class="kv">
            <div class="k">可選頻道 / 人員 / 群組</div>
            <div class="v" id="slackLoadSummary">-</div>
          </div>
        </div>

        <div class="actions">
          <button id="refreshSlackOptionsBtn" class="ghost">重新載入 Slack 資源</button>
        </div>
        <div id="slackErrorStatus" class="warn"></div>
      </section>
    </div>

    <script>
      const slackDefaultChannelFromEnv = ${JSON.stringify(config.slack.defaultChannel)};
      const defaultSlackMessageTemplate = ${JSON.stringify(DEFAULT_SLACK_MESSAGE_TEMPLATE)};

      let discordSources = [];
      let lineSources = [];
      let slackOptions = {
        channels: [],
        users: [],
        usergroups: [],
        errors: [],
        loaded: { channels: 0, users: 0, usergroups: 0 },
      };

      let relaySettings = {
        globalExcludedAuthorIds: [],
        globalExcludedAuthorProfiles: [],
        globalExcludedAuthorRoleIds: [],
        globalExcludedLineSpeakerIds: [],
        globalExcludedLineSpeakerProfiles: [],
        slackMessageTemplate: '',
      };
      let mentionTriggerSettings = {
        discordMentionTrigger: { enabled: false, allowedGuildIds: [], mappings: [] },
        lineMentionTrigger: { enabled: false, allowedGroupIds: [], excludedGroupIds: [], mappings: [] },
        mentionDirectory: { identities: [] },
      };
      let recentDiscordAuthors = [];
      let editingDiscordRuleId = null;
      let editingLineRuleId = null;
      let editingDiscordMentionMappingId = null;
      let editingLineMentionMappingId = null;

      function byId(id) {
        return document.getElementById(id);
      }

      function asInput(id) {
        const el = byId(id);
        return el instanceof HTMLInputElement ? el : null;
      }

      function asSelect(id) {
        const el = byId(id);
        return el instanceof HTMLSelectElement ? el : null;
      }

      function splitCSV(value) {
        return String(value || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
      }

      function mergeIdsToInput(input, ids) {
        const current = splitCSV(input.value);
        const merged = Array.from(new Set(current.concat(ids)));
        input.value = merged.join(', ');
      }

      function normalizeChannelName(raw) {
        const value = String(raw || '').trim();
        return value.startsWith('#') ? value.slice(1) : value;
      }

      function normalizeMentionKey(raw) {
        const value = String(raw || '').trim();
        if (!value) return '';

        const lower = value.toLowerCase();
        if (lower === '@everyone' || lower === '<!everyone>') return '<!everyone>';
        if (lower === '@here' || lower === '<!here>') return '<!here>';
        if (lower === '@channel' || lower === '<!channel>') return '<!channel>';

        const user = value.match(/^<@([a-z0-9]+)>$/i);
        if (user) {
          return '<@' + user[1].toUpperCase() + '>';
        }

        const subteam = value.match(/^<!subteam\^([a-z0-9]+)(\|[^>]+)?>$/i);
        if (subteam) {
          return '<!subteam^' + subteam[1].toUpperCase() + '>';
        }

        if (/^[SUW][A-Z0-9]{8,}$/i.test(value)) {
          return '<@' + value.toUpperCase() + '>';
        }

        return value;
      }

      function getMentionDisplay(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';

        const key = normalizeMentionKey(raw);
        if (key === '<!here>') return 'Here（<!here>）';
        if (key === '<!channel>') return 'Channel（<!channel>）';
        if (key === '<!everyone>') return 'Everyone（<!everyone>）';

        const user = key.match(/^<@([A-Z0-9]+)>$/);
        if (user) {
          const target = slackOptions.users.find((item) => item.id === user[1]);
          if (target) {
            return '使用者: ' + target.displayName + ' (<@' + target.id + '>)';
          }
        }

        const group = key.match(/^<!subteam\^([A-Z0-9]+)>$/);
        if (group) {
          const target = slackOptions.usergroups.find((item) => item.id === group[1]);
          if (target) {
            return '群組: @' + target.handle + ' (' + target.name + ')';
          }
        }

        return raw;
      }

      function getSlackChannelDisplay(value) {
        const target = String(value || '').trim();
        if (!target) return '';

        const byId = slackOptions.channels.find((channel) => channel.id === target);
        if (byId) {
          return '#' + byId.name + ' (' + byId.id + ')';
        }

        const normalized = normalizeChannelName(target);
        const byName = slackOptions.channels.find((channel) => channel.name === normalized);
        if (byName) {
          return '#' + byName.name + ' (' + byName.id + ')';
        }

        return target;
      }

      function getDiscordSourceDisplay(guildId, channelId) {
        const guild = discordSources.find((item) => item.id === guildId);
        const channel = guild?.channels.find((item) => item.id === channelId);

        const guildDisplay = guild
          ? guild.name + ' (' + guild.id + ')'
          : guildId;
        const channelDisplay = channel
          ? '#' + channel.name + ' (' + channel.id + ')'
          : channelId;

        return guildDisplay + ' / ' + channelDisplay;
      }

      function escapeHtml(value) {
        return String(value || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function renderCellLine(label, value) {
        return '<div class="cell-line"><div class="cell-label">' + escapeHtml(label) + '</div><div class="cell-value">' + escapeHtml(value || '-') + '</div></div>';
      }

      function renderMentionList(values) {
        const items = (values || [])
          .map((value) => getMentionDisplay(value))
          .filter(Boolean);

        if (!items.length) {
          return '<span class="cell-value">無</span>';
        }

        return '<div class="mention-list">' + items
          .map((item) => '<span class="mention-pill">' + escapeHtml(item) + '</span>')
          .join('') + '</div>';
      }

      function renderDiscordSourceCell(rule) {
        const guild = discordSources.find((item) => item.id === rule.sourceGuildId);
        const sourceChannelId = String(rule.sourceChannelId || '').trim();
        const channel = sourceChannelId ? guild?.channels.find((item) => item.id === sourceChannelId) : null;
        return '<div class="cell-stack">'
          + renderCellLine('Guild', guild ? guild.name : rule.sourceGuildId)
          + renderCellLine('Guild ID', rule.sourceGuildId)
          + renderCellLine('Channel', sourceChannelId ? (channel ? '#' + channel.name : sourceChannelId) : '全部 Channel')
          + renderCellLine('Channel ID', sourceChannelId || 'ALL')
          + '</div>';
      }

      function renderLineSourceCell(rule) {
        const group = lineSources.find((src) => src.id === rule.sourceGroupId);
        return '<div class="cell-stack">'
          + renderCellLine('Group', group ? group.name : rule.sourceGroupId)
          + renderCellLine('Group ID', rule.sourceGroupId)
          + '</div>';
      }

      function renderTargetCell(targetSlackChannel) {
        return '<div class="cell-stack">'
          + renderCellLine('Slack', getSlackChannelDisplay(targetSlackChannel))
          + renderCellLine('Raw', targetSlackChannel)
          + '</div>';
      }

      function renderPlatformBadge(platform) {
        if (platform === 'Discord') {
          return '<span class="platform-badge discord" title="Discord" aria-label="Discord">🎮</span>';
        }

        if (platform === 'LINE') {
          return '<span class="platform-badge line" title="LINE" aria-label="LINE">🟢</span>';
        }

        return '<span class="platform-badge" title="Webhook" aria-label="Webhook">🔗</span>';
      }

      async function fetchDiscordSources() {
        const res = await fetch('/api/admin/discord-sources');
        const json = await res.json();
        return {
          ready: Boolean(json.ready),
          guilds: json.ready ? (json.guilds || []) : [],
        };
      }

      async function fetchLineSources() {
        const res = await fetch('/api/admin/line-sources');
        const json = await res.json();
        return json.groups || [];
      }

      async function fetchSlackOptions() {
        const res = await fetch('/api/admin/slack-options');
        const json = await res.json();
        return {
          channels: json.channels || [],
          users: json.users || [],
          usergroups: json.usergroups || [],
          errors: json.errors || [],
          loaded: json.loaded || { channels: 0, users: 0, usergroups: 0 },
        };
      }

      async function fetchDiscordRules() {
        const res = await fetch('/api/admin/discord-rules');
        const json = await res.json();
        return json.rules || [];
      }

      async function fetchLineRules() {
        const res = await fetch('/api/admin/line-rules');
        const json = await res.json();
        return json.rules || [];
      }

      async function fetchSettings() {
        const res = await fetch('/api/admin/settings');
        const json = await res.json();
        return json.settings || {
          globalExcludedAuthorIds: [],
          globalExcludedAuthorProfiles: [],
          globalExcludedAuthorRoleIds: [],
          globalExcludedLineSpeakerIds: [],
          globalExcludedLineSpeakerProfiles: [],
          slackMessageTemplate: defaultSlackMessageTemplate,
        };
      }

      async function fetchMentionTriggerSettings() {
        const res = await fetch('/api/admin/mention-trigger');
        const json = await res.json();
        return {
          discordMentionTrigger: json.discordMentionTrigger || { enabled: false, allowedGuildIds: [], mappings: [] },
          lineMentionTrigger: json.lineMentionTrigger || { enabled: false, allowedGroupIds: [], excludedGroupIds: [], mappings: [] },
          mentionDirectory: json.mentionDirectory || { identities: [] },
        };
      }

      async function saveDiscordMentionScope(patch) {
        const res = await fetch('/api/admin/mention-trigger/discord-scope', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error('save discord mention scope failed');
        const json = await res.json();
        return json.discordMentionTrigger;
      }

      async function saveLineMentionScope(patch) {
        const res = await fetch('/api/admin/mention-trigger/line-scope', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) throw new Error('save line mention scope failed');
        const json = await res.json();
        return json.lineMentionTrigger;
      }

      async function saveDiscordMentionMapping(payload, id) {
        const endpoint = id
          ? '/api/admin/mention-trigger/discord-mappings/' + id
          : '/api/admin/mention-trigger/discord-mappings';
        const res = await fetch(endpoint, {
          method: id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('save discord mention mapping failed');
        const json = await res.json();
        return json.discordMentionTrigger;
      }

      async function saveLineMentionMapping(payload, id) {
        const endpoint = id
          ? '/api/admin/mention-trigger/line-mappings/' + id
          : '/api/admin/mention-trigger/line-mappings';
        const res = await fetch(endpoint, {
          method: id ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error('save line mention mapping failed');
        const json = await res.json();
        return json.lineMentionTrigger;
      }

      async function deleteDiscordMentionMapping(id) {
        const res = await fetch('/api/admin/mention-trigger/discord-mappings/' + id, { method: 'DELETE' });
        if (!res.ok) throw new Error('delete discord mention mapping failed');
        const json = await res.json();
        return json.discordMentionTrigger;
      }

      async function deleteLineMentionMapping(id) {
        const res = await fetch('/api/admin/mention-trigger/line-mappings/' + id, { method: 'DELETE' });
        if (!res.ok) throw new Error('delete line mention mapping failed');
        const json = await res.json();
        return json.lineMentionTrigger;
      }

      async function saveMentionIdentityBulk(identities) {
        const res = await fetch('/api/admin/mention-directory/bulk', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identities }),
        });
        if (!res.ok) throw new Error('save mention identity bulk failed');
        const json = await res.json();
        return json.mentionDirectory;
      }

      // Push the Slack mentions assigned in the global-excluded editor back into
      // the Slack identity master (mentionDirectory): the Discord UID is added to
      // the identity whose slackMention matches, creating one if none exists.
      async function syncGlobalExcludedProfilesToMentionDirectory(profiles) {
        const identities = (mentionTriggerSettings.mentionDirectory?.identities || [])
          .map((item) => ({
            ...item,
            discordUserIds: [...(item.discordUserIds || [])],
            lineUserIds: [...(item.lineUserIds || [])],
          }));

        const byMention = new Map();
        for (const identity of identities) {
          const key = String(identity.slackMention || '').trim().toLowerCase();
          if (key) {
            byMention.set(key, identity);
          }
        }

        let changed = false;
        for (const profile of profiles) {
          const slackMention = String(profile.slackMention || '').trim();
          const discordUserId = String(profile.discordUserId || '').trim();
          if (!slackMention || !discordUserId) {
            continue;
          }

          const key = slackMention.toLowerCase();
          let identity = byMention.get(key);
          if (!identity) {
            identity = {
              enabled: true,
              label: String(profile.note || slackMention).trim(),
              slackMention,
              discordUserIds: [],
              lineUserIds: [],
            };
            identities.push(identity);
            byMention.set(key, identity);
            changed = true;
          }

          if (!identity.discordUserIds.includes(discordUserId)) {
            identity.discordUserIds.push(discordUserId);
            changed = true;
          }
        }

        if (!changed) {
          return false;
        }

        const updated = await saveMentionIdentityBulk(identities);
        mentionTriggerSettings.mentionDirectory = updated;
        renderMentionTriggerSettings();
        return true;
      }

      // Same as the Discord sync, but pushes the LINE UID into the matching
      // identity's lineUserIds (creating an identity if none matches the mention).
      async function syncGlobalExcludedLineProfilesToMentionDirectory(profiles) {
        const identities = (mentionTriggerSettings.mentionDirectory?.identities || [])
          .map((item) => ({
            ...item,
            discordUserIds: [...(item.discordUserIds || [])],
            lineUserIds: [...(item.lineUserIds || [])],
          }));

        const byMention = new Map();
        for (const identity of identities) {
          const key = String(identity.slackMention || '').trim().toLowerCase();
          if (key) {
            byMention.set(key, identity);
          }
        }

        let changed = false;
        for (const profile of profiles) {
          const slackMention = String(profile.slackMention || '').trim();
          const lineUserId = String(profile.lineUserId || '').trim();
          if (!slackMention || !lineUserId) {
            continue;
          }

          const key = slackMention.toLowerCase();
          let identity = byMention.get(key);
          if (!identity) {
            identity = {
              enabled: true,
              label: String(profile.note || slackMention).trim(),
              slackMention,
              discordUserIds: [],
              lineUserIds: [],
            };
            identities.push(identity);
            byMention.set(key, identity);
            changed = true;
          }

          if (!identity.lineUserIds.includes(lineUserId)) {
            identity.lineUserIds.push(lineUserId);
            changed = true;
          }
        }

        if (!changed) {
          return false;
        }

        const updated = await saveMentionIdentityBulk(identities);
        mentionTriggerSettings.mentionDirectory = updated;
        renderMentionTriggerSettings();
        return true;
      }

      async function exportRulesFile() {
        const res = await fetch('/api/admin/rules-export');
        if (!res.ok) {
          throw new Error('export rules failed');
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'ape-relay-rules-' + new Date().toISOString().slice(0, 10) + '.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
      }

      async function importRulesFile(file, mode) {
        const text = await file.text();
        const data = JSON.parse(text);
        const res = await fetch('/api/admin/rules-import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode, data }),
        });

        if (!res.ok) {
          throw new Error('import rules failed');
        }

        return res.json();
      }

      async function fetchDiscordAuthors(guildId) {
        const query = guildId ? '?guildId=' + encodeURIComponent(guildId) : '';
        const res = await fetch('/api/admin/discord-authors' + query);
        const json = await res.json();
        return json.authors || [];
      }

      async function fetchLineDebugState() {
        const res = await fetch('/api/admin/line-debug');
        const json = await res.json();
        return json.state || {};
      }

      async function saveSettings(settings) {
        const res = await fetch('/api/admin/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(settings),
        });

        if (!res.ok) {
          throw new Error('save settings failed');
        }

        const json = await res.json();
        return json.settings || {
          globalExcludedAuthorIds: [],
          globalExcludedAuthorProfiles: [],
          globalExcludedAuthorRoleIds: [],
          globalExcludedLineSpeakerIds: [],
          globalExcludedLineSpeakerProfiles: [],
          slackMessageTemplate: defaultSlackMessageTemplate,
        };
      }

      function renderSlackSummary() {
        const defaultChannel = byId('slackDefaultChannel');
        if (defaultChannel instanceof HTMLElement) {
          defaultChannel.textContent = slackDefaultChannelFromEnv;
        }

        const summary = byId('slackLoadSummary');
        if (summary instanceof HTMLElement) {
          summary.textContent =
            slackOptions.loaded.channels + ' / ' +
            slackOptions.loaded.users + ' / ' +
            slackOptions.loaded.usergroups;
        }

        const error = byId('slackErrorStatus');
        if (error instanceof HTMLElement) {
          error.textContent = slackOptions.errors.length
            ? 'Slack 載入部分失敗：' + slackOptions.errors.join(' | ') + '（可先用手動輸入）'
            : '';
        }
      }

      function renderSlackChannelOptions(selectId) {
        const select = asSelect(selectId);
        if (!select) return;

        select.innerHTML = '<option value="">手動輸入</option>';
        for (const channel of slackOptions.channels) {
          const option = document.createElement('option');
          option.value = channel.id;
          option.textContent = '#' + channel.name + ' (' + channel.id + ')';
          select.appendChild(option);
        }
      }

      function renderMentionOptions(selectId) {
        const select = asSelect(selectId);
        if (!select) return;

        select.innerHTML = '';

        const preset = [
          { value: '<!here>', label: 'Here（<!here>）' },
          { value: '<!channel>', label: 'Channel（<!channel>）' },
          { value: '<!everyone>', label: 'Everyone（<!everyone>）' },
        ];

        for (const item of preset) {
          const option = document.createElement('option');
          option.value = item.value;
          option.textContent = item.label;
          select.appendChild(option);
        }

        for (const user of slackOptions.users) {
          const option = document.createElement('option');
          option.value = '<@' + user.id + '>';
          option.textContent = '使用者: ' + user.displayName + ' (<@' + user.id + '>)';
          select.appendChild(option);
        }

        for (const group of slackOptions.usergroups) {
          const option = document.createElement('option');
          option.value = '<!subteam^' + group.id + '|@' + group.handle + '>';
          option.textContent = '群組: @' + group.handle + ' (' + group.name + ')';
          select.appendChild(option);
        }
      }

      function collectMentionTargets(selectId, customInputId) {
        const select = asSelect(selectId);
        const custom = asInput(customInputId);
        const targets = [];

        if (select) {
          for (const option of select.selectedOptions) {
            const value = option.value.trim();
            if (value) targets.push(value);
          }
        }

        if (custom) {
          const customTargets = splitCSV(custom.value);
          for (const target of customTargets) {
            targets.push(target);
          }
        }

        return Array.from(new Set(targets));
      }

      function renderGuildOptions() {
        const guildSelect = asSelect('guildSelect');
        if (!guildSelect) return;

        guildSelect.innerHTML = '<option value="">手動輸入</option>';
        for (const guild of discordSources) {
          const option = document.createElement('option');
          option.value = guild.id;
          option.textContent = guild.name + ' (' + guild.id + ')';
          guildSelect.appendChild(option);
        }

        const status = byId('discordSourceStatus');
        if (status instanceof HTMLElement) {
          const channelCount = discordSources.reduce((sum, guild) => sum + (guild.channels?.length || 0), 0);
          status.textContent = discordSources.length
            ? '已載入 Discord Guild：' + discordSources.length + '，Channel：' + channelCount
            : 'Discord bot 尚未 ready，或尚未載入到 Guild/Channel；可稍後按更新。';
        }
      }

      function renderChannelOptions(guildId) {
        const channelSelect = asSelect('channelSelect');
        if (!channelSelect) return;

        channelSelect.innerHTML = '<option value="">請手動選擇 / 輸入</option>';
        const guild = discordSources.find((g) => g.id === guildId);
        if (!guild) {
          return;
        }

        for (const channel of guild.channels) {
          const option = document.createElement('option');
          option.value = channel.id;
          option.textContent = channel.name + ' (' + channel.id + ')';
          channelSelect.appendChild(option);
        }
      }

      function renderGlobalSettings() {
        const input = asInput('globalExcludedAuthorIds');
        if (input) {
          input.value = (relaySettings.globalExcludedAuthorIds || []).join(', ');
        }
        renderGlobalExcludedAuthorRows();

        const roleInput = asInput('globalExcludedAuthorRoleIds');
        if (roleInput) {
          roleInput.value = (relaySettings.globalExcludedAuthorRoleIds || []).join(', ');
        }

        const lineInput = asInput('globalExcludedLineSpeakerIds');
        if (lineInput) {
          lineInput.value = (relaySettings.globalExcludedLineSpeakerIds || []).join(', ');
        }
        renderGlobalExcludedLineSpeakerRows();

        const templateInput = byId('slackMessageTemplate');
        if (templateInput instanceof HTMLTextAreaElement) {
          templateInput.value = relaySettings.slackMessageTemplate || defaultSlackMessageTemplate;
        }
      }

      function getSlackDisplayNameFromMention(mention) {
        const slackUserId = getSlackUserIdFromMention(mention);
        if (!slackUserId) {
          return '';
        }

        const user = (slackOptions.users || []).find((item) => String(item.id || '').toUpperCase() === slackUserId);
        return user ? String(user.displayName || user.id || '').trim() : '';
      }

      function getMappedIdentityByDiscordUserId(discordUserId) {
        const targetId = String(discordUserId || '').trim();
        if (!targetId) {
          return null;
        }

        const identities = mentionTriggerSettings.mentionDirectory?.identities || [];
        return identities.find((item) => (item.discordUserIds || []).includes(targetId)) || null;
      }

      function renderGlobalExcludedAuthorRows() {
        const rows = byId('globalExcludedAuthorRows');
        if (!(rows instanceof HTMLElement)) {
          return;
        }

        const ids = splitCSV(asInput('globalExcludedAuthorIds')?.value || '');
        const profileMap = new Map();
        for (const item of relaySettings.globalExcludedAuthorProfiles || []) {
          const id = String(item?.discordUserId || '').trim();
          if (id) {
            profileMap.set(id, item);
          }
        }

        rows.innerHTML = '';

        for (const id of ids) {
          const existing = profileMap.get(id);
          const mappedIdentity = getMappedIdentityByDiscordUserId(id);
          const mappedMention = String(mappedIdentity?.slackMention || '').trim();
          const slackMention = String(existing?.slackMention || mappedMention || '').trim();
          const resolvedName = getSlackDisplayNameFromMention(slackMention);
          const fallbackAuthor = (recentDiscordAuthors || []).find((author) => String(author.id || '').trim() === id);
          const fallbackNote = String(mappedIdentity?.label || fallbackAuthor?.displayName || '').trim();
          const note = String(existing?.note || resolvedName || fallbackNote || '').trim();

          const row = document.createElement('tr');
          row.className = 'global-excluded-row';
          row.dataset.discordUserId = id;

          const idCell = document.createElement('td');
          const noteCell = document.createElement('td');
          const slackCell = document.createElement('td');
          const actionCell = document.createElement('td');

          const idInput = document.createElement('input');
          idInput.value = id;
          idInput.dataset.field = 'discordUserId';

          const noteInput = document.createElement('input');
          noteInput.value = note;
          noteInput.placeholder = '例如：採購窗口、內部 PM';
          noteInput.dataset.field = 'note';

          const slackSelect = document.createElement('select');
          slackSelect.dataset.field = 'slackMention';
          const emptyOption = document.createElement('option');
          emptyOption.value = '';
          emptyOption.textContent = '不指定';
          slackSelect.appendChild(emptyOption);

          const sortedUsers = [...(slackOptions.users || [])]
            .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-Hant'));
          for (const user of sortedUsers) {
            const option = document.createElement('option');
            option.value = '<@' + user.id + '>';
            option.textContent = user.displayName + ' (<@' + user.id + '>)';
            slackSelect.appendChild(option);
          }

          if (slackMention && !Array.from(slackSelect.options).some((option) => option.value === slackMention)) {
            const legacyOption = document.createElement('option');
            legacyOption.value = slackMention;
            legacyOption.textContent = '既有值: ' + slackMention;
            slackSelect.appendChild(legacyOption);
          }
          slackSelect.value = slackMention;

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'secondary';
          removeBtn.dataset.action = 'remove-global-excluded-row';
          removeBtn.textContent = '移除';

          idCell.appendChild(idInput);
          noteCell.appendChild(noteInput);
          slackCell.appendChild(slackSelect);
          actionCell.appendChild(removeBtn);
          row.appendChild(idCell);
          row.appendChild(noteCell);
          row.appendChild(slackCell);
          row.appendChild(actionCell);
          rows.appendChild(row);
        }

        if (!ids.length) {
          const emptyRow = document.createElement('tr');
          const emptyCell = document.createElement('td');
          emptyCell.colSpan = 4;
          emptyCell.className = 'hint';
          emptyCell.textContent = '目前沒有全域排除作者 ID。先從上方輸入或「近期作者加入」。';
          emptyRow.appendChild(emptyCell);
          rows.appendChild(emptyRow);
        }
      }

      function collectGlobalExcludedAuthorProfilesFromRows() {
        const rows = byId('globalExcludedAuthorRows');
        if (!(rows instanceof HTMLElement)) {
          return [];
        }

        const result = [];
        const seen = new Set();
        const items = rows.querySelectorAll('.global-excluded-row');
        for (const row of items) {
          if (!(row instanceof HTMLElement)) {
            continue;
          }

          const idInput = row.querySelector('input[data-field="discordUserId"]');
          const noteInput = row.querySelector('input[data-field="note"]');
          const slackSelect = row.querySelector('select[data-field="slackMention"]');

          const discordUserId = idInput instanceof HTMLInputElement
            ? idInput.value.trim()
            : '';
          if (!discordUserId || seen.has(discordUserId)) {
            continue;
          }

          seen.add(discordUserId);
          const note = noteInput instanceof HTMLInputElement
            ? noteInput.value.trim()
            : '';
          const slackMention = slackSelect instanceof HTMLSelectElement
            ? slackSelect.value.trim()
            : '';

          result.push({
            discordUserId,
            note,
            slackMention: slackMention || undefined,
          });
        }

        return result;
      }

      function getMappedIdentityByLineUserId(lineUserId) {
        const targetId = String(lineUserId || '').trim();
        if (!targetId) {
          return null;
        }

        const identities = mentionTriggerSettings.mentionDirectory?.identities || [];
        return identities.find((item) => (item.lineUserIds || []).includes(targetId)) || null;
      }

      function getLineSpeakerDisplayName(lineUserId) {
        const targetId = String(lineUserId || '').trim();
        if (!targetId) {
          return '';
        }

        for (const group of lineSources) {
          for (const speaker of group.speakers || []) {
            if (String(speaker.id || '').trim() === targetId) {
              return String(speaker.displayName || '').trim();
            }
          }
        }

        return '';
      }

      function renderGlobalExcludedLineSpeakerRows() {
        const rows = byId('globalExcludedLineSpeakerRows');
        if (!(rows instanceof HTMLElement)) {
          return;
        }

        const ids = splitCSV(asInput('globalExcludedLineSpeakerIds')?.value || '');
        const profileMap = new Map();
        for (const item of relaySettings.globalExcludedLineSpeakerProfiles || []) {
          const id = String(item?.lineUserId || '').trim();
          if (id) {
            profileMap.set(id, item);
          }
        }

        rows.innerHTML = '';

        for (const id of ids) {
          const existing = profileMap.get(id);
          const mappedIdentity = getMappedIdentityByLineUserId(id);
          const mappedMention = String(mappedIdentity?.slackMention || '').trim();
          const slackMention = String(existing?.slackMention || mappedMention || '').trim();
          const resolvedName = getSlackDisplayNameFromMention(slackMention);
          const fallbackName = getLineSpeakerDisplayName(id);
          const fallbackNote = String(mappedIdentity?.label || fallbackName || '').trim();
          const note = String(existing?.note || resolvedName || fallbackNote || '').trim();

          const row = document.createElement('tr');
          row.className = 'global-excluded-row';
          row.dataset.lineUserId = id;

          const idCell = document.createElement('td');
          const noteCell = document.createElement('td');
          const slackCell = document.createElement('td');
          const actionCell = document.createElement('td');

          const idInput = document.createElement('input');
          idInput.value = id;
          idInput.dataset.field = 'lineUserId';

          const noteInput = document.createElement('input');
          noteInput.value = note;
          noteInput.placeholder = '例如：採購窗口、內部 PM';
          noteInput.dataset.field = 'note';

          const slackSelect = document.createElement('select');
          slackSelect.dataset.field = 'slackMention';
          const emptyOption = document.createElement('option');
          emptyOption.value = '';
          emptyOption.textContent = '不指定';
          slackSelect.appendChild(emptyOption);

          const sortedUsers = [...(slackOptions.users || [])]
            .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-Hant'));
          for (const user of sortedUsers) {
            const option = document.createElement('option');
            option.value = '<@' + user.id + '>';
            option.textContent = user.displayName + ' (<@' + user.id + '>)';
            slackSelect.appendChild(option);
          }

          if (slackMention && !Array.from(slackSelect.options).some((option) => option.value === slackMention)) {
            const legacyOption = document.createElement('option');
            legacyOption.value = slackMention;
            legacyOption.textContent = '既有值: ' + slackMention;
            slackSelect.appendChild(legacyOption);
          }
          slackSelect.value = slackMention;

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.className = 'secondary';
          removeBtn.dataset.action = 'remove-global-excluded-line-row';
          removeBtn.textContent = '移除';

          idCell.appendChild(idInput);
          noteCell.appendChild(noteInput);
          slackCell.appendChild(slackSelect);
          actionCell.appendChild(removeBtn);
          row.appendChild(idCell);
          row.appendChild(noteCell);
          row.appendChild(slackCell);
          row.appendChild(actionCell);
          rows.appendChild(row);
        }

        if (!ids.length) {
          const emptyRow = document.createElement('tr');
          const emptyCell = document.createElement('td');
          emptyCell.colSpan = 4;
          emptyCell.className = 'hint';
          emptyCell.textContent = '目前沒有 LINE 全域排除發言者 ID。先從上方輸入或「最近發言者加入」。';
          emptyRow.appendChild(emptyCell);
          rows.appendChild(emptyRow);
        }
      }

      function collectGlobalExcludedLineSpeakerProfilesFromRows() {
        const rows = byId('globalExcludedLineSpeakerRows');
        if (!(rows instanceof HTMLElement)) {
          return [];
        }

        const result = [];
        const seen = new Set();
        const items = rows.querySelectorAll('.global-excluded-row');
        for (const row of items) {
          if (!(row instanceof HTMLElement)) {
            continue;
          }

          const idInput = row.querySelector('input[data-field="lineUserId"]');
          const noteInput = row.querySelector('input[data-field="note"]');
          const slackSelect = row.querySelector('select[data-field="slackMention"]');

          const lineUserId = idInput instanceof HTMLInputElement
            ? idInput.value.trim()
            : '';
          if (!lineUserId || seen.has(lineUserId)) {
            continue;
          }

          seen.add(lineUserId);
          const note = noteInput instanceof HTMLInputElement
            ? noteInput.value.trim()
            : '';
          const slackMention = slackSelect instanceof HTMLSelectElement
            ? slackSelect.value.trim()
            : '';

          result.push({
            lineUserId,
            note,
            slackMention: slackMention || undefined,
          });
        }

        return result;
      }

      function getAllDiscordRoleOptions() {
        const dedup = new Map();
        for (const guild of discordSources) {
          for (const role of guild.roles || []) {
            if (!dedup.has(role.id)) {
              dedup.set(role.id, { ...role, guildName: guild.name });
            }
          }
        }

        return Array.from(dedup.values())
          .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));
      }

      function renderGlobalExcludedAuthorRoleOptions() {
        const select = asSelect('globalExcludedAuthorRoleSelect');
        if (!select) return;

        select.innerHTML = '';
        for (const role of getAllDiscordRoleOptions()) {
          const option = document.createElement('option');
          option.value = role.id;
          option.textContent = role.name + ' (' + role.id + ') [' + role.guildName + ']';
          select.appendChild(option);
        }
      }

      function renderRuleExcludedAuthorRoleOptions(guildId) {
        const select = asSelect('excludedAuthorRoleSelect');
        if (!select) return;

        select.innerHTML = '';
        const guild = discordSources.find((item) => item.id === guildId);
        const roles = guild?.roles || [];
        for (const role of roles) {
          const option = document.createElement('option');
          option.value = role.id;
          option.textContent = role.name + ' (' + role.id + ')';
          select.appendChild(option);
        }
      }

      function renderGlobalLineSpeakerOptions() {
        const select = asSelect('globalLineExcludedSpeakerSelect');
        if (!select) return;

        select.innerHTML = '';
        const seen = new Set();
        for (const group of lineSources) {
          for (const speaker of group.speakers || []) {
            if (seen.has(speaker.id)) {
              continue;
            }
            seen.add(speaker.id);
            const option = document.createElement('option');
            option.value = speaker.id;
            option.textContent = speaker.displayName + ' (' + speaker.id + ')';
            select.appendChild(option);
          }
        }
      }

      function renderDiscordMentionRecentOptions() {
        const select = asSelect('mentionIdentityDiscordRecentSelect');
        if (!select) return;

        select.innerHTML = '';
        for (const author of recentDiscordAuthors) {
          const option = document.createElement('option');
          option.value = author.id;
          option.textContent = author.displayName + ' (' + author.id + ')';
          select.appendChild(option);
        }
      }

      function renderLineMentionRecentOptions() {
        const select = asSelect('mentionIdentityLineRecentSelect');
        if (!select) return;

        select.innerHTML = '';
        const seen = new Set();
        for (const group of lineSources) {
          for (const speaker of group.speakers || []) {
            if (seen.has(speaker.id)) continue;
            seen.add(speaker.id);
            const option = document.createElement('option');
            option.value = speaker.id;
            option.textContent = speaker.displayName + ' (' + speaker.id + ')';
            select.appendChild(option);
          }
        }
      }

      function renderExcludedAuthorOptions() {
        const globalSelect = asSelect('globalExcludedAuthorSelect');
        if (globalSelect) {
          globalSelect.innerHTML = '';
          for (const author of recentDiscordAuthors) {
            const option = document.createElement('option');
            option.value = author.id;
            option.textContent = author.displayName + ' (' + author.id + ')';
            globalSelect.appendChild(option);
          }
        }

        const ruleSelect = asSelect('excludedAuthorSelect');
        if (ruleSelect) {
          ruleSelect.innerHTML = '';
          for (const author of recentDiscordAuthors) {
            const option = document.createElement('option');
            option.value = author.id;
            option.textContent = author.displayName + ' (' + author.id + ')';
            ruleSelect.appendChild(option);
          }
        }

        renderGlobalExcludedAuthorRows();
      }

      async function refreshExcludedAuthorOptions() {
        const guildId = asInput('guildId')?.value.trim() || '';
        recentDiscordAuthors = await fetchDiscordAuthors(guildId || undefined);
        renderExcludedAuthorOptions();
        renderDiscordMentionRecentOptions();
      }

      async function refreshDiscordSources() {
        const result = await fetchDiscordSources();
        discordSources = result.guilds;
        renderGuildOptions();
        renderGlobalExcludedAuthorRoleOptions();
        renderRuleExcludedAuthorRoleOptions(asInput('guildId')?.value.trim() || asSelect('guildSelect')?.value || '');
        renderChannelOptions(asInput('guildId')?.value.trim() || asSelect('guildSelect')?.value || '');
        await refreshExcludedAuthorOptions();
        await refreshSharedRules();
        return result.ready;
      }

      async function retryDiscordSourcesIfEmpty() {
        if (discordSources.length > 0) {
          return;
        }

        const ready = await refreshDiscordSources();
        if (!ready) {
          window.setTimeout(() => {
            void refreshDiscordSources();
          }, 2000);
        }
      }

      function renderLineGroupOptions() {
        const select = asSelect('lineGroupSelect');
        if (!select) return;

        select.innerHTML = '<option value="">請選擇群組</option>';
        for (const group of lineSources) {
          const option = document.createElement('option');
          option.value = group.id;
          option.textContent = group.name + ' (' + group.id + ')';
          select.appendChild(option);
        }

        const status = byId('lineGroupStatus');
        if (status instanceof HTMLElement) {
          status.textContent = '已偵測最近 LINE 群組：' + lineSources.length;
        }
      }

      function renderLineSpeakerOptions(groupId) {
        const select = asSelect('lineSpeakerSelect');
        if (!select) return;

        select.innerHTML = '';
        const group = lineSources.find((item) => item.id === groupId);
        if (!group) {
          return;
        }

        for (const speaker of group.speakers || []) {
          const option = document.createElement('option');
          option.value = speaker.id;
          option.textContent = speaker.displayName + ' (' + speaker.id + ')';
          select.appendChild(option);
        }
      }

      function getSlackUserIdFromMention(mention) {
        const value = String(mention || '').trim();
        const matched = value.match(/^<@([A-Z0-9]+)>$/i);
        return matched ? matched[1].toUpperCase() : '';
      }

      function splitMentionDirectoryIdentities() {
        const all = mentionTriggerSettings.mentionDirectory?.identities || [];
        const slackUserMap = new Map();
        const nonUserIdentities = [];

        for (const item of all) {
          const slackUserId = getSlackUserIdFromMention(item.slackMention);
          if (slackUserId) {
            slackUserMap.set(slackUserId, item);
          } else {
            nonUserIdentities.push(item);
          }
        }

        return { slackUserMap, nonUserIdentities };
      }

      function collectMentionIdentityRowsForBulkSave() {
        const rows = byId('mentionIdentityRows');
        if (!(rows instanceof HTMLElement)) {
          return [];
        }

        const result = [];
        const items = rows.querySelectorAll('tr[data-slack-user-id]');
        for (const row of items) {
          if (!(row instanceof HTMLTableRowElement)) {
            continue;
          }

          const slackUserId = String(row.dataset.slackUserId || '').trim();
          if (!slackUserId) {
            continue;
          }

          const labelInput = row.querySelector('input[data-field="label"]');
          const discordInput = row.querySelector('input[data-field="discord"]');
          const lineInput = row.querySelector('input[data-field="line"]');
          const enabledInput = row.querySelector('input[data-field="enabled"]');
          const id = String(row.dataset.identityId || '').trim();

          const label = labelInput instanceof HTMLInputElement
            ? labelInput.value.trim()
            : '';
          const discordUserIds = discordInput instanceof HTMLInputElement
            ? splitCSV(discordInput.value)
            : [];
          const lineUserIds = lineInput instanceof HTMLInputElement
            ? splitCSV(lineInput.value)
            : [];
          const enabled = enabledInput instanceof HTMLInputElement
            ? Boolean(enabledInput.checked)
            : false;

          result.push({
            id: id || undefined,
            enabled,
            label: label || ('<@' + slackUserId + '>'),
            slackMention: '<@' + slackUserId + '>',
            discordUserIds,
            lineUserIds,
          });
        }

        return result;
      }

      function getSelectedMentionIdentityRows() {
        const rows = byId('mentionIdentityRows');
        if (!(rows instanceof HTMLElement)) {
          return [];
        }

        const selected = [];
        const items = rows.querySelectorAll('tr[data-slack-user-id]');
        for (const row of items) {
          if (!(row instanceof HTMLTableRowElement)) {
            continue;
          }

          const checkbox = row.querySelector('input[data-field="row-select"]');
          if (checkbox instanceof HTMLInputElement && checkbox.checked) {
            selected.push(row);
          }
        }

        return selected;
      }

      function appendIdsToMentionRows(field, ids) {
        const selectedRows = getSelectedMentionIdentityRows();
        if (!selectedRows.length) {
          return 0;
        }

        const cleaned = ids.map((id) => String(id).trim()).filter(Boolean);
        if (!cleaned.length) {
          return 0;
        }

        for (const row of selectedRows) {
          const input = row.querySelector('input[data-field="' + field + '"]');
          if (!(input instanceof HTMLInputElement)) {
            continue;
          }

          const merged = Array.from(new Set(splitCSV(input.value).concat(cleaned)));
          input.value = merged.join(', ');
        }

        return selectedRows.length;
      }

      function renderMentionTriggerSettings() {
        const discordScope = mentionTriggerSettings.discordMentionTrigger || { enabled: false, allowedGuildIds: [], mappings: [] };
        const lineScope = mentionTriggerSettings.lineMentionTrigger || { enabled: false, allowedGroupIds: [], excludedGroupIds: [], mappings: [] };
        const mentionDirectory = mentionTriggerSettings.mentionDirectory || { identities: [] };

        const discordEnabled = asInput('mentionDiscordEnabled');
        if (discordEnabled) discordEnabled.checked = Boolean(discordScope.enabled);
        const discordGuilds = asInput('mentionDiscordAllowedGuildIds');
        if (discordGuilds) discordGuilds.value = (discordScope.allowedGuildIds || []).join(', ');

        const lineEnabled = asInput('mentionLineEnabled');
        if (lineEnabled) lineEnabled.checked = Boolean(lineScope.enabled);
        const lineAllowed = asInput('mentionLineAllowedGroupIds');
        if (lineAllowed) lineAllowed.value = (lineScope.allowedGroupIds || []).join(', ');
        const lineExcluded = asInput('mentionLineExcludedGroupIds');
        if (lineExcluded) lineExcluded.value = (lineScope.excludedGroupIds || []).join(', ');

        const identityRows = byId('mentionIdentityRows');
        if (identityRows instanceof HTMLElement) {
          identityRows.innerHTML = '';

          const sortedUsers = [...(slackOptions.users || [])]
            .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-Hant'));
          const { slackUserMap } = splitMentionDirectoryIdentities();

          for (const user of sortedUsers) {
            const identity = slackUserMap.get(String(user.id || '').toUpperCase());
            const label = String(identity?.label || user.displayName || user.id || '').trim();
            const discordUserIds = (identity?.discordUserIds || []).join(', ');
            const lineUserIds = (identity?.lineUserIds || []).join(', ');
            const enabled = Boolean(identity?.enabled ?? false);
            const tr = document.createElement('tr');
            tr.dataset.slackUserId = String(user.id || '').toUpperCase();
            tr.dataset.identityId = String(identity?.id || '').trim();
            tr.innerHTML = [
              '<td><input type="checkbox" data-field="row-select" /></td>',
              '<td><div class="cell-stack"><div class="cell-value">' + escapeHtml(user.displayName || user.id) + '</div><div class="cell-label">' + escapeHtml(user.id) + '</div><input data-field="label" value="' + escapeHtml(label) + '" placeholder="可自訂 label" style="margin-top:6px;" /></div></td>',
              '<td><span class="mention-pill">' + escapeHtml('<@' + user.id + '>') + '</span></td>',
              '<td><input data-field="discord" value="' + escapeHtml(discordUserIds) + '" placeholder="Discord IDs，逗號分隔" /></td>',
              '<td><input data-field="line" value="' + escapeHtml(lineUserIds) + '" placeholder="LINE IDs，逗號分隔" /></td>',
              '<td><input type="checkbox" data-field="enabled" ' + (enabled ? 'checked' : '') + ' /></td>',
            ].join('');
            identityRows.appendChild(tr);
          }

          if (!sortedUsers.length) {
            const tr = document.createElement('tr');
            tr.innerHTML = '<td colspan="6">目前未載入 Slack 成員，請先按「重新同步 Slack 成員」。</td>';
            identityRows.appendChild(tr);
          }
        }

        const legacyRows = byId('legacyMentionMappingRows');
        if (legacyRows instanceof HTMLElement) {
          legacyRows.innerHTML = '';

          for (const mapping of discordScope.mappings || []) {
            const tr = document.createElement('tr');
            tr.innerHTML = [
              '<td>Discord</td>',
              '<td>' + escapeHtml(mapping.discordUserId) + '</td>',
              '<td>' + escapeHtml(mapping.slackMention) + '</td>',
              '<td>' + (mapping.enabled ? '是' : '否') + '</td>',
            ].join('');
            legacyRows.appendChild(tr);
          }

          for (const mapping of lineScope.mappings || []) {
            const tr = document.createElement('tr');
            tr.innerHTML = [
              '<td>LINE</td>',
              '<td>' + escapeHtml(mapping.lineUserId) + '</td>',
              '<td>' + escapeHtml(mapping.slackMention) + '</td>',
              '<td>' + (mapping.enabled ? '是' : '否') + '</td>',
            ].join('');
            legacyRows.appendChild(tr);
          }
        }
      }

      function setDiscordCreateMode() {
        editingDiscordRuleId = null;
        const btn = byId('saveDiscordRuleBtn');
        if (btn instanceof HTMLButtonElement) {
          btn.textContent = '建立規則';
        }
        const cancelBtn = byId('cancelDiscordEditBtn');
        if (cancelBtn instanceof HTMLButtonElement) {
          cancelBtn.style.display = 'none';
        }

        const fields = [
          'discordName',
          'guildId',
          'channelId',
          'discordSlackChannel',
          'discordMentionsCustom',
          'excludedAuthorIds',
          'excludedAuthorRoleIds',
        ];
        for (const id of fields) {
          const input = asInput(id);
          if (input) input.value = '';
        }

        const guildSelect = asSelect('guildSelect');
        if (guildSelect) guildSelect.value = '';
        renderRuleExcludedAuthorRoleOptions('');
        renderChannelOptions('');

        const channelSelect = asSelect('channelSelect');
        if (channelSelect) channelSelect.value = '';

        const slackSelect = asSelect('discordSlackChannelSelect');
        if (slackSelect) slackSelect.value = '';

        const enabled = asInput('discordEnabled');
        if (enabled) enabled.checked = true;
      }

      function fillDiscordForm(rule) {
        const assign = [
          ['discordName', rule.name],
          ['guildId', rule.sourceGuildId],
          ['channelId', rule.sourceChannelId],
          ['discordSlackChannel', rule.targetSlackChannel],
        ];

        for (const [id, value] of assign) {
          const input = asInput(id);
          if (input) input.value = value || '';
        }

        const guildSelect = asSelect('guildSelect');
        if (guildSelect) guildSelect.value = rule.sourceGuildId || '';
        renderRuleExcludedAuthorRoleOptions(rule.sourceGuildId || '');
        renderChannelOptions(rule.sourceGuildId || '');

        const channelSelect = asSelect('channelSelect');
        if (channelSelect) channelSelect.value = rule.sourceChannelId || '';

        const slackSelect = asSelect('discordSlackChannelSelect');
        if (slackSelect) {
          const target = String(rule.targetSlackChannel || '').trim();
          const byId = slackOptions.channels.find((channel) => channel.id === target);
          if (byId) {
            slackSelect.value = byId.id;
          } else {
            const normalized = normalizeChannelName(target);
            const byName = slackOptions.channels.find((channel) => channel.name === normalized);
            slackSelect.value = byName ? byName.id : '';
          }
        }

        const enabled = asInput('discordEnabled');
        if (enabled) enabled.checked = Boolean(rule.enabled);

        const mentionTargets = new Set(rule.mentionTargets || []);
        const select = asSelect('discordMentionTargets');
        if (select) {
          for (const option of select.options) {
            option.selected = false;
            const optionKey = normalizeMentionKey(option.value);
            for (const target of Array.from(mentionTargets)) {
              if (normalizeMentionKey(target) === optionKey) {
                option.selected = true;
                mentionTargets.delete(target);
                break;
              }
            }
          }
        }

        const custom = asInput('discordMentionsCustom');
        if (custom) {
          custom.value = Array.from(mentionTargets).join(', ');
        }

        const excluded = asInput('excludedAuthorIds');
        if (excluded) {
          excluded.value = (rule.excludedAuthorIds || []).join(', ');
        }

        const excludedRoles = asInput('excludedAuthorRoleIds');
        if (excludedRoles) {
          excludedRoles.value = (rule.excludedAuthorRoleIds || []).join(', ');
        }

        const saveBtn = byId('saveDiscordRuleBtn');
        if (saveBtn instanceof HTMLButtonElement) {
          saveBtn.textContent = '更新規則';
        }

        const cancelBtn = byId('cancelDiscordEditBtn');
        if (cancelBtn instanceof HTMLButtonElement) {
          cancelBtn.style.display = 'inline-block';
        }

        editingDiscordRuleId = rule.id;
        refreshExcludedAuthorOptions();
      }

      function setLineCreateMode() {
        editingLineRuleId = null;
        const btn = byId('saveLineRuleBtn');
        if (btn instanceof HTMLButtonElement) {
          btn.textContent = '建立規則';
        }
        const cancelBtn = byId('cancelLineEditBtn');
        if (cancelBtn instanceof HTMLButtonElement) {
          cancelBtn.style.display = 'none';
        }

        const fields = ['lineName', 'lineGroupId', 'lineSlackChannel', 'lineMentionsCustom', 'lineExcludedSpeakerIds'];
        for (const id of fields) {
          const input = asInput(id);
          if (input) input.value = '';
        }

        const groupSelect = asSelect('lineGroupSelect');
        if (groupSelect) groupSelect.value = '';

        const channelSelect = asSelect('lineSlackChannelSelect');
        if (channelSelect) channelSelect.value = '';

        const speakers = asSelect('lineSpeakerSelect');
        if (speakers) speakers.innerHTML = '';

        const enabled = asInput('lineEnabled');
        if (enabled) enabled.checked = true;
      }

      function fillLineForm(rule) {
        const assign = [
          ['lineName', rule.name],
          ['lineGroupId', rule.sourceGroupId],
          ['lineSlackChannel', rule.targetSlackChannel],
        ];

        for (const [id, value] of assign) {
          const input = asInput(id);
          if (input) input.value = value || '';
        }

        const groupSelect = asSelect('lineGroupSelect');
        if (groupSelect) {
          groupSelect.value = rule.sourceGroupId || '';
        }
        renderLineSpeakerOptions(rule.sourceGroupId || '');

        const slackSelect = asSelect('lineSlackChannelSelect');
        if (slackSelect) {
          const target = String(rule.targetSlackChannel || '').trim();
          const byId = slackOptions.channels.find((channel) => channel.id === target);
          if (byId) {
            slackSelect.value = byId.id;
          } else {
            const normalized = normalizeChannelName(target);
            const byName = slackOptions.channels.find((channel) => channel.name === normalized);
            slackSelect.value = byName ? byName.id : '';
          }
        }

        const enabled = asInput('lineEnabled');
        if (enabled) enabled.checked = Boolean(rule.enabled);

        const mentionTargets = new Set(rule.mentionTargets || []);
        const select = asSelect('lineMentionTargets');
        if (select) {
          for (const option of select.options) {
            option.selected = false;
            const optionKey = normalizeMentionKey(option.value);
            for (const target of Array.from(mentionTargets)) {
              if (normalizeMentionKey(target) === optionKey) {
                option.selected = true;
                mentionTargets.delete(target);
                break;
              }
            }
          }
        }

        const custom = asInput('lineMentionsCustom');
        if (custom) {
          custom.value = Array.from(mentionTargets).join(', ');
        }

        const speakers = asInput('lineExcludedSpeakerIds');
        if (speakers) {
          speakers.value = (rule.excludedSpeakerIds || []).join(', ');
        }

        const saveBtn = byId('saveLineRuleBtn');
        if (saveBtn instanceof HTMLButtonElement) {
          saveBtn.textContent = '更新規則';
        }

        const cancelBtn = byId('cancelLineEditBtn');
        if (cancelBtn instanceof HTMLButtonElement) {
          cancelBtn.style.display = 'inline-block';
        }

        editingLineRuleId = rule.id;
      }

      async function refreshSharedRules() {
        const [discordRules, lineRules] = await Promise.all([
          fetchDiscordRules(),
          fetchLineRules(),
        ]);

        const rows = byId('sharedRuleRows');
        if (!(rows instanceof HTMLElement)) return;

        rows.innerHTML = '';

        const merged = [
          ...discordRules.map((rule) => ({ platform: 'Discord', rule })),
          ...lineRules.map((rule) => ({ platform: 'LINE', rule })),
        ];

        for (const item of merged) {
          const tr = document.createElement('tr');

          if (item.platform === 'Discord') {
            const rule = item.rule;
            const mentionDisplay = (rule.mentionTargets || [])
              .map((value) => getMentionDisplay(value))
              .filter(Boolean)
              .join(' ');
            const excludedUserRows = (rule.excludedAuthorIds || []).map((id) => renderCellLine('User', id));
            const excludedRoleRows = (rule.excludedAuthorRoleIds || []).map((id) => renderCellLine('Role', id));
            const excludedDisplay = excludedUserRows.length || excludedRoleRows.length
              ? '<div class="cell-stack">' + excludedUserRows.join('') + excludedRoleRows.join('') + '</div>'
              : '<span class="cell-value">無</span>';

            tr.innerHTML = [
              '<td>' + renderPlatformBadge('Discord') + '</td>',
              '<td>' + escapeHtml(rule.name) + '</td>',
              '<td>' + renderDiscordSourceCell(rule) + '</td>',
              '<td title="' + escapeHtml(rule.targetSlackChannel) + '">' + renderTargetCell(rule.targetSlackChannel) + '</td>',
              '<td>' + renderMentionList(rule.mentionTargets || []) + '</td>',
              '<td>' + excludedDisplay + '</td>',
              '<td><input type="checkbox" ' + (rule.enabled ? 'checked' : '') + ' data-action="toggle-discord" data-id="' + rule.id + '" /></td>',
              '<td><div class="table-actions"><button class="secondary" data-action="edit-discord" data-id="' + rule.id + '">編輯</button><button class="secondary" data-action="delete-discord" data-id="' + rule.id + '">刪除</button></div></td>',
            ].join('');
          } else {
            const rule = item.rule;

            tr.innerHTML = [
              '<td>' + renderPlatformBadge('LINE') + '</td>',
              '<td>' + escapeHtml(rule.name) + '</td>',
              '<td>' + renderLineSourceCell(rule) + '</td>',
              '<td title="' + escapeHtml(rule.targetSlackChannel) + '">' + renderTargetCell(rule.targetSlackChannel) + '</td>',
              '<td>' + renderMentionList(rule.mentionTargets || []) + '</td>',
              '<td>' + ((rule.excludedSpeakerIds || []).length ? '<div class="cell-stack">' + (rule.excludedSpeakerIds || []).map((id) => renderCellLine('Exclude', id)).join('') + '</div>' : '<span class="cell-value">無</span>') + '</td>',
              '<td><input type="checkbox" ' + (rule.enabled ? 'checked' : '') + ' data-action="toggle-line" data-id="' + rule.id + '" /></td>',
              '<td><div class="table-actions"><button class="secondary" data-action="edit-line" data-id="' + rule.id + '">編輯</button><button class="secondary" data-action="delete-line" data-id="' + rule.id + '">刪除</button></div></td>',
            ].join('');
          }

          rows.appendChild(tr);
        }
      }

      async function refreshLineDebug() {
        const state = await fetchLineDebugState();
        const pre = byId('lineDebugDump');
        if (pre instanceof HTMLElement) {
          pre.textContent = JSON.stringify(state, null, 2);
        }
      }

      function wireTabs() {
        const nav = byId('tabNav');
        if (!(nav instanceof HTMLElement)) return;

        nav.addEventListener('click', (event) => {
          const btn = event.target;
          if (!(btn instanceof HTMLElement)) return;
          const target = btn.dataset.tab;
          if (!target) return;

          for (const b of nav.querySelectorAll('.tab-btn')) {
            b.classList.remove('active');
          }
          btn.classList.add('active');

          for (const panel of document.querySelectorAll('.tab-panel')) {
            panel.classList.remove('active');
          }
          const activePanel = byId('tab-' + target);
          if (activePanel instanceof HTMLElement) {
            activePanel.classList.add('active');
          }
        });
      }

      function wireEvents() {
        byId('exportRulesBtn')?.addEventListener('click', async () => {
          const status = byId('ruleTransferStatus');
          try {
            await exportRulesFile();
            if (status instanceof HTMLElement) {
              status.textContent = '已匯出目前所有規則與全域設定。';
            }
          } catch {
            if (status instanceof HTMLElement) {
              status.textContent = '匯出失敗，請稍後再試。';
            }
          }
        });

        byId('importRulesBtn')?.addEventListener('click', async () => {
          const fileInput = byId('importRulesFile');
          const modeSelect = asSelect('importRulesMode');
          const status = byId('ruleTransferStatus');
          if (!(fileInput instanceof HTMLInputElement) || !fileInput.files?.length) {
            if (status instanceof HTMLElement) {
              status.textContent = '請先選擇要匯入的 JSON 檔。';
            }
            return;
          }

          const mode = modeSelect?.value === 'replace' ? 'replace' : 'merge';
          const confirmMessage = mode === 'replace'
            ? '這會覆蓋目前所有 Discord/LINE 規則與全域排除設定，確定要匯入？'
            : '這會把檔案內的規則合併新增到目前設定，確定要匯入？';

          if (!window.confirm(confirmMessage)) {
            return;
          }

          try {
            const result = await importRulesFile(fileInput.files[0], mode);
            const summary = result.summary || { discordRules: 0, lineRules: 0, globalExcludedAuthorIds: 0, globalExcludedLineSpeakerIds: 0 };
            relaySettings = await fetchSettings();
            renderGlobalSettings();
            await refreshSharedRules();
            fileInput.value = '';
            if (status instanceof HTMLElement) {
              status.textContent = '匯入完成：Discord ' + summary.discordRules + ' 條、LINE ' + summary.lineRules + ' 條、Discord 全域排除 ' + summary.globalExcludedAuthorIds + ' 筆、LINE 全域排除 ' + summary.globalExcludedLineSpeakerIds + ' 筆。';
            }
          } catch {
            if (status instanceof HTMLElement) {
              status.textContent = '匯入失敗，請確認 JSON 是從 ApeRelay 匯出的規則檔。';
            }
          }
        });

        byId('refreshSlackOptionsBtn')?.addEventListener('click', async () => {
          slackOptions = await fetchSlackOptions();
          renderSlackSummary();
          renderSlackChannelOptions('discordSlackChannelSelect');
          renderSlackChannelOptions('lineSlackChannelSelect');
          renderMentionOptions('discordMentionTargets');
          renderMentionOptions('lineMentionTargets');
          await refreshSharedRules();
        });

        byId('refreshDiscordSourcesBtn')?.addEventListener('click', async () => {
          await refreshDiscordSources();
        });

        byId('refreshLineSourcesBtn')?.addEventListener('click', async () => {
          lineSources = await fetchLineSources();
          renderLineGroupOptions();
          renderGlobalLineSpeakerOptions();
          renderLineMentionRecentOptions();
          const groupId = asInput('lineGroupId')?.value.trim() || asSelect('lineGroupSelect')?.value || '';
          renderLineSpeakerOptions(groupId);
          await refreshSharedRules();
        });

        byId('refreshLineDebugBtn')?.addEventListener('click', async () => {
          await refreshLineDebug();
        });

        byId('saveGlobalSettingsBtn')?.addEventListener('click', async () => {
          const input = asInput('globalExcludedAuthorIds');
          const profileRows = collectGlobalExcludedAuthorProfilesFromRows();
          const profileIds = profileRows.map((item) => item.discordUserId);
          const values = Array.from(new Set(profileIds.concat(input ? splitCSV(input.value) : [])));
          if (input) {
            input.value = values.join(', ');
          }

          // Ensure every global excluded ID has a profile row for later editing.
          const profileMap = new Map(profileRows.map((item) => [item.discordUserId, item]));
          const profiles = values.map((id) => {
            const existing = profileMap.get(id);
            if (existing) {
              return existing;
            }
            const mappedIdentity = getMappedIdentityByDiscordUserId(id);
            const mappedMention = String(mappedIdentity?.slackMention || '').trim();
            return {
              discordUserId: id,
              note: String(mappedIdentity?.label || '').trim(),
              slackMention: mappedMention || undefined,
            };
          });

          const roleInput = asInput('globalExcludedAuthorRoleIds');
          const roleValues = roleInput ? splitCSV(roleInput.value) : [];

          try {
            relaySettings = await saveSettings({
              globalExcludedAuthorIds: values,
              globalExcludedAuthorProfiles: profiles,
              globalExcludedAuthorRoleIds: roleValues,
            });
            renderGlobalSettings();

            let syncedToDirectory = false;
            let syncFailed = false;
            try {
              syncedToDirectory = await syncGlobalExcludedProfilesToMentionDirectory(profiles);
            } catch {
              syncFailed = true;
            }

            const status = byId('globalSettingsStatus');
            if (status instanceof HTMLElement) {
              let message = '全域排除作者已儲存（執行期 union 立即生效）。';
              if (syncedToDirectory) {
                message += '已同步指定的 Slack 對象到身分主檔。';
              } else if (syncFailed) {
                message += '但同步到 Slack 身分主檔失敗，請至「Slack 身分主檔」確認。';
              }
              status.textContent = message;
            }
          } catch {
            const status = byId('globalSettingsStatus');
            if (status instanceof HTMLElement) {
              status.textContent = '儲存全域設定失敗，請稍後再試。';
            }
          }
        });

        byId('saveLineGlobalSettingsBtn')?.addEventListener('click', async () => {
          const input = asInput('globalExcludedLineSpeakerIds');
          const profileRows = collectGlobalExcludedLineSpeakerProfilesFromRows();
          const profileIds = profileRows.map((item) => item.lineUserId);
          const values = Array.from(new Set(profileIds.concat(input ? splitCSV(input.value) : [])));
          if (input) {
            input.value = values.join(', ');
          }

          // Ensure every global excluded ID has a profile row for later editing.
          const profileMap = new Map(profileRows.map((item) => [item.lineUserId, item]));
          const profiles = values.map((id) => {
            const existing = profileMap.get(id);
            if (existing) {
              return existing;
            }
            const mappedIdentity = getMappedIdentityByLineUserId(id);
            const mappedMention = String(mappedIdentity?.slackMention || '').trim();
            return {
              lineUserId: id,
              note: String(mappedIdentity?.label || '').trim(),
              slackMention: mappedMention || undefined,
            };
          });

          try {
            relaySettings = await saveSettings({
              globalExcludedLineSpeakerIds: values,
              globalExcludedLineSpeakerProfiles: profiles,
            });
            renderGlobalSettings();

            let syncedToDirectory = false;
            let syncFailed = false;
            try {
              syncedToDirectory = await syncGlobalExcludedLineProfilesToMentionDirectory(profiles);
            } catch {
              syncFailed = true;
            }

            const status = byId('lineGlobalSettingsStatus');
            if (status instanceof HTMLElement) {
              let message = 'LINE 全域排除發言者已儲存（執行期 union 立即生效）。';
              if (syncedToDirectory) {
                message += '已同步指定的 Slack 對象到身分主檔。';
              } else if (syncFailed) {
                message += '但同步到 Slack 身分主檔失敗，請至「Slack 身分主檔」確認。';
              }
              status.textContent = message;
            }
          } catch {
            const status = byId('lineGlobalSettingsStatus');
            if (status instanceof HTMLElement) {
              status.textContent = '儲存 LINE 全域設定失敗，請稍後再試。';
            }
          }
        });

        byId('saveSlackTemplateBtn')?.addEventListener('click', async () => {
          const templateInput = byId('slackMessageTemplate');
          const value = templateInput instanceof HTMLTextAreaElement ? templateInput.value : '';
          const status = byId('slackTemplateStatus');
          try {
            relaySettings = await saveSettings({ slackMessageTemplate: value });
            renderGlobalSettings();
            if (status instanceof HTMLElement) {
              status.textContent = 'Slack 訊息格式已儲存，立即生效。';
            }
          } catch {
            if (status instanceof HTMLElement) {
              status.textContent = '儲存 Slack 訊息格式失敗，請稍後再試。';
            }
          }
        });

        byId('resetSlackTemplateBtn')?.addEventListener('click', () => {
          const templateInput = byId('slackMessageTemplate');
          if (templateInput instanceof HTMLTextAreaElement) {
            templateInput.value = defaultSlackMessageTemplate;
          }
          const status = byId('slackTemplateStatus');
          if (status instanceof HTMLElement) {
            status.textContent = '已還原為預設模板（尚未儲存，請按「儲存訊息格式」生效）。';
          }
        });

        byId('saveDiscordMentionScopeBtn')?.addEventListener('click', async () => {
          const enabled = Boolean(asInput('mentionDiscordEnabled')?.checked);
          const allowedGuildIds = splitCSV(asInput('mentionDiscordAllowedGuildIds')?.value || '');
          const status = byId('mentionIdentityStatus');
          try {
            const updated = await saveDiscordMentionScope({ enabled, allowedGuildIds });
            mentionTriggerSettings.discordMentionTrigger = updated;
            renderMentionTriggerSettings();
            if (status instanceof HTMLElement) {
              status.textContent = 'Discord Mention Trigger 範圍已儲存。';
            }
          } catch {
            if (status instanceof HTMLElement) {
              status.textContent = '儲存 Discord Mention Trigger 範圍失敗。';
            }
          }
        });

        byId('saveLineMentionScopeBtn')?.addEventListener('click', async () => {
          const enabled = Boolean(asInput('mentionLineEnabled')?.checked);
          const allowedGroupIds = splitCSV(asInput('mentionLineAllowedGroupIds')?.value || '');
          const excludedGroupIds = splitCSV(asInput('mentionLineExcludedGroupIds')?.value || '');
          const status = byId('mentionIdentityStatus');
          try {
            const updated = await saveLineMentionScope({ enabled, allowedGroupIds, excludedGroupIds });
            mentionTriggerSettings.lineMentionTrigger = updated;
            renderMentionTriggerSettings();
            if (status instanceof HTMLElement) {
              status.textContent = 'LINE Mention Trigger 範圍已儲存。';
            }
          } catch {
            if (status instanceof HTMLElement) {
              status.textContent = '儲存 LINE Mention Trigger 範圍失敗。';
            }
          }
        });

        byId('addGlobalExcludedAuthorBtn')?.addEventListener('click', () => {
          const select = asSelect('globalExcludedAuthorSelect');
          const input = asInput('globalExcludedAuthorIds');
          if (!select || !input) return;
          const ids = Array.from(select.selectedOptions).map((option) => option.value.trim()).filter(Boolean);
          mergeIdsToInput(input, ids);
          renderGlobalExcludedAuthorRows();
        });

        byId('addGlobalExcludedAuthorRoleBtn')?.addEventListener('click', () => {
          const select = asSelect('globalExcludedAuthorRoleSelect');
          const input = asInput('globalExcludedAuthorRoleIds');
          if (!select || !input) return;
          const ids = Array.from(select.selectedOptions).map((option) => option.value.trim()).filter(Boolean);
          mergeIdsToInput(input, ids);
        });

        byId('syncGlobalExcludedAuthorRowsBtn')?.addEventListener('click', () => {
          renderGlobalExcludedAuthorRows();
        });

        byId('globalExcludedAuthorRows')?.addEventListener('change', (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) {
            return;
          }

          if (target instanceof HTMLSelectElement && target.dataset.field === 'slackMention') {
            const row = target.closest('.global-excluded-row');
            if (!(row instanceof HTMLElement)) {
              return;
            }

            const noteInput = row.querySelector('input[data-field="note"]');
            if (!(noteInput instanceof HTMLInputElement)) {
              return;
            }

            if (!noteInput.value.trim()) {
              const displayName = getSlackDisplayNameFromMention(target.value);
              if (displayName) {
                noteInput.value = displayName;
              }
            }
          }
        });

        byId('globalExcludedAuthorRows')?.addEventListener('click', (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) {
            return;
          }

          if (target.dataset.action !== 'remove-global-excluded-row') {
            return;
          }

          const row = target.closest('.global-excluded-row');
          if (!(row instanceof HTMLElement)) {
            return;
          }

          row.remove();
          const remaining = collectGlobalExcludedAuthorProfilesFromRows().map((item) => item.discordUserId);
          const input = asInput('globalExcludedAuthorIds');
          if (input) {
            input.value = remaining.join(', ');
          }
        });

        byId('addExcludedAuthorBtn')?.addEventListener('click', () => {
          const select = asSelect('excludedAuthorSelect');
          const input = asInput('excludedAuthorIds');
          if (!select || !input) return;
          const ids = Array.from(select.selectedOptions).map((option) => option.value.trim()).filter(Boolean);
          mergeIdsToInput(input, ids);
        });

        byId('addExcludedAuthorRoleBtn')?.addEventListener('click', () => {
          const select = asSelect('excludedAuthorRoleSelect');
          const input = asInput('excludedAuthorRoleIds');
          if (!select || !input) return;
          const ids = Array.from(select.selectedOptions).map((option) => option.value.trim()).filter(Boolean);
          mergeIdsToInput(input, ids);
        });

        byId('addGlobalLineExcludedSpeakerBtn')?.addEventListener('click', () => {
          const select = asSelect('globalLineExcludedSpeakerSelect');
          const input = asInput('globalExcludedLineSpeakerIds');
          if (!select || !input) return;
          const ids = Array.from(select.selectedOptions).map((option) => option.value.trim()).filter(Boolean);
          mergeIdsToInput(input, ids);
          renderGlobalExcludedLineSpeakerRows();
        });

        byId('syncGlobalExcludedLineSpeakerRowsBtn')?.addEventListener('click', () => {
          renderGlobalExcludedLineSpeakerRows();
        });

        byId('globalExcludedLineSpeakerRows')?.addEventListener('change', (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) {
            return;
          }

          if (target instanceof HTMLSelectElement && target.dataset.field === 'slackMention') {
            const row = target.closest('.global-excluded-row');
            if (!(row instanceof HTMLElement)) {
              return;
            }

            const noteInput = row.querySelector('input[data-field="note"]');
            if (!(noteInput instanceof HTMLInputElement)) {
              return;
            }

            if (!noteInput.value.trim()) {
              const displayName = getSlackDisplayNameFromMention(target.value);
              if (displayName) {
                noteInput.value = displayName;
              }
            }
          }
        });

        byId('globalExcludedLineSpeakerRows')?.addEventListener('click', (event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) {
            return;
          }

          if (target.dataset.action !== 'remove-global-excluded-line-row') {
            return;
          }

          const row = target.closest('.global-excluded-row');
          if (!(row instanceof HTMLElement)) {
            return;
          }

          row.remove();
          const remaining = collectGlobalExcludedLineSpeakerProfilesFromRows().map((item) => item.lineUserId);
          const input = asInput('globalExcludedLineSpeakerIds');
          if (input) {
            input.value = remaining.join(', ');
          }
        });

        byId('refreshMentionIdentityFromSlackBtn')?.addEventListener('click', async () => {
          const status = byId('mentionIdentityStatus');
          try {
            slackOptions = await fetchSlackOptions();
            renderSlackSummary();
            renderMentionTriggerSettings();
            if (status instanceof HTMLElement) {
              status.textContent = '已同步 Slack 成員清單。';
            }
          } catch {
            if (status instanceof HTMLElement) {
              status.textContent = '同步 Slack 成員失敗。';
            }
          }
        });

        byId('selectAllMentionIdentityRowsBtn')?.addEventListener('click', () => {
          const rows = byId('mentionIdentityRows');
          if (!(rows instanceof HTMLElement)) {
            return;
          }

          const checkboxes = rows.querySelectorAll('input[data-field="row-select"]');
          for (const box of checkboxes) {
            if (box instanceof HTMLInputElement) {
              box.checked = true;
            }
          }
        });

        byId('clearMentionIdentityRowsSelectionBtn')?.addEventListener('click', () => {
          const rows = byId('mentionIdentityRows');
          if (!(rows instanceof HTMLElement)) {
            return;
          }

          const checkboxes = rows.querySelectorAll('input[data-field="row-select"]');
          for (const box of checkboxes) {
            if (box instanceof HTMLInputElement) {
              box.checked = false;
            }
          }
        });

        byId('addMentionIdentityDiscordRecentBtn')?.addEventListener('click', () => {
          const status = byId('mentionIdentityStatus');
          const select = asSelect('mentionIdentityDiscordRecentSelect');
          if (!select) {
            return;
          }

          const ids = Array.from(select.selectedOptions)
            .map((option) => option.value.trim())
            .filter(Boolean);
          const changedRows = appendIdsToMentionRows('discord', ids);

          if (status instanceof HTMLElement) {
            status.textContent = changedRows > 0
              ? '已把 Discord UID 套用到 ' + changedRows + ' 列。'
              : '請先勾選要套用的 Slack 成員列。';
          }
        });

        byId('addMentionIdentityLineRecentBtn')?.addEventListener('click', () => {
          const status = byId('mentionIdentityStatus');
          const select = asSelect('mentionIdentityLineRecentSelect');
          if (!select) {
            return;
          }

          const ids = Array.from(select.selectedOptions)
            .map((option) => option.value.trim())
            .filter(Boolean);
          const changedRows = appendIdsToMentionRows('line', ids);

          if (status instanceof HTMLElement) {
            status.textContent = changedRows > 0
              ? '已把 LINE UID 套用到 ' + changedRows + ' 列。'
              : '請先勾選要套用的 Slack 成員列。';
          }
        });

        byId('saveMentionIdentityBulkBtn')?.addEventListener('click', async () => {
          const status = byId('mentionIdentityStatus');

          try {
            const { nonUserIdentities } = splitMentionDirectoryIdentities();
            const slackMemberIdentities = collectMentionIdentityRowsForBulkSave();
            const updated = await saveMentionIdentityBulk(nonUserIdentities.concat(slackMemberIdentities));
            mentionTriggerSettings.mentionDirectory = updated;
            renderMentionTriggerSettings();
            if (status instanceof HTMLElement) {
              status.textContent = 'Slack 成員映射已整批儲存。';
            }
          } catch {
            if (status instanceof HTMLElement) {
              status.textContent = '整批儲存失敗，請稍後再試。';
            }
          }
        });

        byId('addLineSpeakerBtn')?.addEventListener('click', () => {
          const select = asSelect('lineSpeakerSelect');
          const input = asInput('lineExcludedSpeakerIds');
          if (!select || !input) return;
          const ids = Array.from(select.selectedOptions).map((option) => option.value.trim()).filter(Boolean);
          mergeIdsToInput(input, ids);
        });

        byId('guildSelect')?.addEventListener('change', () => {
          const guildValue = asSelect('guildSelect')?.value || '';
          const guildInput = asInput('guildId');
          if (guildInput) guildInput.value = guildValue;
          renderRuleExcludedAuthorRoleOptions(guildValue);
          renderChannelOptions(guildValue);
          refreshExcludedAuthorOptions();
        });

        byId('guildId')?.addEventListener('change', () => {
          const guildValue = asInput('guildId')?.value.trim() || '';
          renderRuleExcludedAuthorRoleOptions(guildValue);
          refreshExcludedAuthorOptions();
        });

        byId('channelSelect')?.addEventListener('change', () => {
          const channelValue = asSelect('channelSelect')?.value || '';
          const channelInput = asInput('channelId');
          if (channelInput) channelInput.value = channelValue;
        });

        byId('discordSlackChannelSelect')?.addEventListener('change', () => {
          const value = asSelect('discordSlackChannelSelect')?.value || '';
          const input = asInput('discordSlackChannel');
          if (input) input.value = value;
        });

        byId('lineSlackChannelSelect')?.addEventListener('change', () => {
          const value = asSelect('lineSlackChannelSelect')?.value || '';
          const input = asInput('lineSlackChannel');
          if (input) input.value = value;
        });

        byId('lineGroupSelect')?.addEventListener('change', () => {
          const value = asSelect('lineGroupSelect')?.value || '';
          const input = asInput('lineGroupId');
          if (input) input.value = value;
          renderLineSpeakerOptions(value);
        });

        byId('lineGroupId')?.addEventListener('change', () => {
          const value = asInput('lineGroupId')?.value.trim() || '';
          renderLineSpeakerOptions(value);
        });

        byId('cancelDiscordEditBtn')?.addEventListener('click', () => {
          setDiscordCreateMode();
        });

        byId('cancelLineEditBtn')?.addEventListener('click', () => {
          setLineCreateMode();
        });

        byId('saveDiscordRuleBtn')?.addEventListener('click', async () => {
          const payload = {
            name: asInput('discordName')?.value || '',
            sourceGuildId: asInput('guildId')?.value || '',
            sourceChannelId: asInput('channelId')?.value || '',
            targetSlackChannel: asInput('discordSlackChannel')?.value || '',
            mentionTargets: collectMentionTargets('discordMentionTargets', 'discordMentionsCustom'),
            excludedAuthorIds: splitCSV(asInput('excludedAuthorIds')?.value || ''),
            excludedAuthorRoleIds: splitCSV(asInput('excludedAuthorRoleIds')?.value || ''),
            enabled: Boolean(asInput('discordEnabled')?.checked),
          };

          const isEdit = Boolean(editingDiscordRuleId);
          const endpoint = isEdit
            ? '/api/admin/discord-rules/' + editingDiscordRuleId
            : '/api/admin/discord-rules';

          const res = await fetch(endpoint, {
            method: isEdit ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            let message = '儲存 Discord 規則失敗，請檢查欄位。';
            try {
              const json = await res.json();
              if (json && typeof json.message === 'string' && json.message.trim()) {
                message = '儲存 Discord 規則失敗：' + json.message;
              }
            } catch {
              // ignore invalid response body
            }
            alert(message);
            return;
          }

          setDiscordCreateMode();
          await refreshSharedRules();
        });

        byId('saveLineRuleBtn')?.addEventListener('click', async () => {
          const payload = {
            name: asInput('lineName')?.value || '',
            sourceGroupId: asInput('lineGroupId')?.value || '',
            targetSlackChannel: asInput('lineSlackChannel')?.value || '',
            mentionTargets: collectMentionTargets('lineMentionTargets', 'lineMentionsCustom'),
            excludedSpeakerIds: splitCSV(asInput('lineExcludedSpeakerIds')?.value || ''),
            enabled: Boolean(asInput('lineEnabled')?.checked),
          };

          const isEdit = Boolean(editingLineRuleId);
          const endpoint = isEdit
            ? '/api/admin/line-rules/' + editingLineRuleId
            : '/api/admin/line-rules';

          const res = await fetch(endpoint, {
            method: isEdit ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            let message = '儲存 LINE 規則失敗，請檢查欄位。';
            try {
              const json = await res.json();
              if (json && typeof json.message === 'string' && json.message.trim()) {
                message = '儲存 LINE 規則失敗：' + json.message;
              }
            } catch {
              // ignore invalid response body
            }
            alert(message);
            return;
          }

          setLineCreateMode();
          await refreshSharedRules();
        });

        byId('sharedRuleRows')?.addEventListener('click', async (event) => {
          const btn = event.target;
          if (!(btn instanceof HTMLElement)) return;

          const action = btn.dataset.action;
          const id = btn.dataset.id;
          if (!action || !id) return;

          if (action === 'edit-discord') {
            const rules = await fetchDiscordRules();
            const target = rules.find((rule) => rule.id === id);
            if (target) {
              fillDiscordForm(target);
            }
            return;
          }

          if (action === 'delete-discord') {
            await fetch('/api/admin/discord-rules/' + id, { method: 'DELETE' });
            await refreshSharedRules();
          }

          if (action === 'edit-line') {
            const rules = await fetchLineRules();
            const target = rules.find((rule) => rule.id === id);
            if (target) {
              fillLineForm(target);
            }
            return;
          }

          if (action === 'delete-line') {
            await fetch('/api/admin/line-rules/' + id, { method: 'DELETE' });
            await refreshSharedRules();
          }
        });

        byId('sharedRuleRows')?.addEventListener('change', async (event) => {
          const input = event.target;
          if (!(input instanceof HTMLInputElement)) return;
          const action = input.dataset.action;
          const id = input.dataset.id;
          if (!action || !id) return;

          if (action === 'toggle-line') {
            await fetch('/api/admin/line-rules/' + id, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: input.checked }),
            });
            await refreshSharedRules();
            return;
          }

          if (action === 'toggle-discord') {
            await fetch('/api/admin/discord-rules/' + id, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: input.checked }),
            });
            await refreshSharedRules();
          }
        });

      }

      (async () => {
        wireTabs();
        wireEvents();

        const [
          discordSourceResult,
          loadedLineSources,
          loadedSlackOptions,
          loadedRelaySettings,
          loadedMentionTriggerSettings,
        ] = await Promise.all([
          fetchDiscordSources(),
          fetchLineSources(),
          fetchSlackOptions(),
          fetchSettings(),
          fetchMentionTriggerSettings(),
        ]);

        discordSources = discordSourceResult.guilds;
        lineSources = loadedLineSources;
        slackOptions = loadedSlackOptions;
        relaySettings = loadedRelaySettings;
        mentionTriggerSettings = loadedMentionTriggerSettings;

        await refreshExcludedAuthorOptions();

        renderGuildOptions();
        renderChannelOptions('');
        renderLineGroupOptions();
        renderGlobalLineSpeakerOptions();
        renderLineMentionRecentOptions();

        renderSlackSummary();
        renderSlackChannelOptions('discordSlackChannelSelect');
        renderSlackChannelOptions('lineSlackChannelSelect');

        renderMentionOptions('discordMentionTargets');
        renderMentionOptions('lineMentionTargets');

        renderGlobalSettings();
        renderMentionTriggerSettings();

        setDiscordCreateMode();
        setLineCreateMode();

        await Promise.all([
          refreshSharedRules(),
          refreshLineDebug(),
        ]);

        await retryDiscordSourcesIfEmpty();
      })();
    </script>
  </body>
</html>`);
});

export default router;
