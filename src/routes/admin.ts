import { Router } from 'express';
import { fetch } from 'undici';
import {
  createDiscordRelayRule,
  deleteDiscordRelayRule,
  getDiscordRelayRules,
  getRelaySettings,
  updateDiscordRelayRule,
  updateRelaySettings,
} from '../admin/relayRuleStore.js';
import { getDiscordRecentAuthorOptions, getDiscordSourceOptions } from '../discord/discordClient.js';
import { getLineWebhookDebugState } from '../sources/lineSource.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import type { DiscordRelayRule } from '../types.js';

const router = Router();

type SlackChannelOption = { id: string; name: string };
type SlackUserOption = { id: string; displayName: string };
type SlackUserGroupOption = { id: string; handle: string; name: string };

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

  const users: SlackUserOption[] = [];
  try {
    const res = await fetch('https://slack.com/api/users.list?limit=500', {
      method: 'GET',
      headers,
    });
    const json = (await res.json()) as {
      ok: boolean;
      error?: string;
      members?: Array<{ id: string; name: string; deleted?: boolean; is_bot?: boolean; profile?: { display_name?: string; real_name?: string } }>;
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

function parseRuleInput(
  input: Partial<DiscordRelayRule>,
): Omit<DiscordRelayRule, 'id'> | null {
  if (
    !input.name ||
    !input.sourceGuildId ||
    !input.sourceChannelId ||
    !input.targetSlackChannel
  ) {
    return null;
  }

  return {
    name: String(input.name).trim(),
    enabled: Boolean(input.enabled ?? true),
    sourceGuildId: String(input.sourceGuildId).trim(),
    sourceChannelId: String(input.sourceChannelId).trim(),
    targetSlackChannel: String(input.targetSlackChannel).trim(),
    mentionTargets: Array.isArray(input.mentionTargets)
      ? input.mentionTargets.map((value) => String(value).trim()).filter(Boolean)
      : [],
    excludedAuthorIds: Array.isArray(input.excludedAuthorIds)
      ? input.excludedAuthorIds.map((value) => String(value).trim()).filter(Boolean)
      : [],
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

router.get('/api/admin/line-debug', (_req, res) => {
  res.json({ ok: true, state: getLineWebhookDebugState() });
});

router.get('/api/admin/slack-options', async (_req, res) => {
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
});

router.get('/api/admin/discord-rules', async (_req, res) => {
  const rules = await getDiscordRelayRules();
  res.json({ ok: true, rules });
});

router.get('/api/admin/settings', async (_req, res) => {
  const settings = await getRelaySettings();
  res.json({ ok: true, settings });
});

router.put('/api/admin/settings', async (req, res) => {
  const body = req.body as { globalExcludedAuthorIds?: unknown };

  const globalExcludedAuthorIds = Array.isArray(body.globalExcludedAuthorIds)
    ? body.globalExcludedAuthorIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  const settings = await updateRelaySettings({ globalExcludedAuthorIds });
  res.json({ ok: true, settings });
});

router.post('/api/admin/discord-rules', async (req, res) => {
  const payload = parseRuleInput(req.body as Partial<DiscordRelayRule>);
  if (!payload) {
    res.status(400).json({ ok: false, message: 'Invalid rule payload.' });
    return;
  }

  const created = await createDiscordRelayRule(payload);
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

router.get('/admin', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>搬磚猿 Web Admin</title>
    <style>
      body { font-family: "Noto Sans TC", "PingFang TC", sans-serif; margin: 24px; background: #f8fafc; color: #0f172a; }
      h1 { margin: 0 0 12px; }
      .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
      label { display: block; margin: 8px 0 4px; font-size: 14px; color: #334155; }
      input { width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; }
      button { border: 0; border-radius: 8px; padding: 8px 12px; background: #0f766e; color: #fff; cursor: pointer; }
      button.secondary { background: #475569; }
      select { width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; border-bottom: 1px solid #e2e8f0; padding: 8px; font-size: 14px; }
      .row-actions { display: flex; gap: 8px; }
      .hint { font-size: 13px; color: #64748b; }
      .warning { font-size: 13px; color: #b45309; margin-top: 6px; }
      .list { margin: 8px 0 0; padding-left: 18px; color: #334155; }
    </style>
  </head>
  <body>
    <h1>搬磚猿 Web Admin</h1>
    <p class="hint">管理多組 Discord → Slack 規則。每組規則可設定目標 Slack 頻道與預設標記。</p>

    <div class="card">
      <h2>全域排除作者（Global）</h2>
      <p class="hint">這份名單會在執行期與每條規則的排除名單做 union。新增規則時不會複製 global，後續修改可即時同步影響全部規則。</p>
      <label>Discord User ID（多個用逗號分隔）</label>
      <input id="globalExcludedAuthorIds" placeholder="例如 123456789012345678, 987654321098765432" />
      <label style="margin-top:8px;">從近期作者加入（可多選）</label>
      <select id="globalExcludedAuthorSelect" multiple size="6"></select>
      <button id="addGlobalExcludedAuthorBtn" class="secondary" style="margin-top:8px;">加入到全域排除</button>
      <button id="saveGlobalSettingsBtn" style="margin-top:8px;">儲存全域設定</button>
      <div id="globalSettingsStatus" class="hint" style="margin-top:8px;"></div>
    </div>

    <div class="card">
      <h2>操作教學</h2>
      <ol class="list">
        <li>Discord Guild / Channel 可用下拉選，或手動輸入 ID（可從 Discord URL 取得）。</li>
        <li>Slack 目標可用 <code>#channel</code> 或 <code>C123...</code>。</li>
        <li>預設標記可多選，也可以在自訂欄位額外填多個對象（逗號分隔）。</li>
        <li>轉發訊息會自動帶上來源連結（Discord message URL）。</li>
        <li>圖片或附件訊息會附上檔案連結，避免漏訊息。</li>
      </ol>
    </div>

    <div class="card">
      <h2>新增規則</h2>
      <label>規則名稱</label>
      <input id="name" placeholder="例如：Parco Discord → #parco-alert" />

      <label>Discord Guild（可下拉）</label>
      <select id="guildSelect">
        <option value="">手動輸入</option>
      </select>
      <input id="guildId" placeholder="838735527204093962" />

      <label>Discord Channel（可下拉）</label>
      <select id="channelSelect">
        <option value="">請先選 Guild 或手動輸入</option>
      </select>
      <input id="channelId" placeholder="838741333845737503" />

      <label>Slack Channel（#name 或 C123...）</label>
      <select id="slackChannelSelect">
        <option value="">手動輸入</option>
      </select>
      <div id="slackChannelStatus" class="hint"></div>
      <input id="slackChannel" placeholder="#封存-programmer" />

      <label>預設標記對象（可多選，下拉可選使用者/群組）</label>
      <select id="mentionTargets" multiple size="4">
        <option value="<!here>">Here（<!here>）</option>
        <option value="<!channel>">Channel（<!channel>）</option>
        <option value="<!everyone>">Everyone（<!everyone>）</option>
      </select>
      <div id="mentionStatus" class="hint"></div>
      <div id="slackErrorStatus" class="warning"></div>
      <input id="mentionsCustom" placeholder="額外自訂標記，多個用逗號分隔，例如 <@U12345>, <@U99999>" style="margin-top:8px;" />

      <label>排除轉發作者（Discord User ID，多個用逗號分隔）</label>
      <input id="excludedAuthorIds" placeholder="例如 123456789012345678, 987654321098765432" />
      <label style="margin-top:8px;">從近期作者加入（可多選）</label>
      <select id="excludedAuthorSelect" multiple size="6"></select>
      <button id="addExcludedAuthorBtn" class="secondary" style="margin-top:8px;">加入到規則排除</button>

      <label><input id="enabled" type="checkbox" checked /> 啟用</label>
      <button id="createBtn">建立規則</button>
      <button id="cancelEditBtn" class="secondary" style="display:none; margin-left:8px;">取消編輯</button>
    </div>

    <div class="card">
      <h2>規則列表</h2>
      <table>
        <thead>
          <tr>
            <th>名稱</th>
            <th>啟用</th>
            <th>Discord 來源</th>
            <th>Slack 目標</th>
            <th>預設標記</th>
            <th>排除作者</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody id="ruleRows"></tbody>
      </table>
    </div>

    <script>
      let discordSources = [];
      let slackOptions = { channels: [], users: [], usergroups: [], errors: [], loaded: { channels: 0, users: 0, usergroups: 0 } };
      let relaySettings = { globalExcludedAuthorIds: [] };
      let recentDiscordAuthors = [];
      let editingRuleId = null;

      async function fetchRules() {
        const res = await fetch('/api/admin/discord-rules');
        const json = await res.json();
        return json.rules || [];
      }

      async function fetchDiscordSources() {
        const res = await fetch('/api/admin/discord-sources');
        const json = await res.json();
        if (!json.ready) {
          return [];
        }
        return json.guilds || [];
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

      async function fetchSettings() {
        const res = await fetch('/api/admin/settings');
        const json = await res.json();
        return json.settings || { globalExcludedAuthorIds: [] };
      }

      async function fetchDiscordAuthors(guildId) {
        const query = guildId ? '?guildId=' + encodeURIComponent(guildId) : '';
        const res = await fetch('/api/admin/discord-authors' + query);
        const json = await res.json();
        return json.authors || [];
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
        return json.settings || { globalExcludedAuthorIds: [] };
      }

      function renderSlackChannelOptions() {
        const select = document.getElementById('slackChannelSelect');
        if (!(select instanceof HTMLSelectElement)) return;

        select.innerHTML = '<option value="">手動輸入</option>';
        for (const channel of slackOptions.channels) {
          const option = document.createElement('option');
          option.value = channel.id;
          option.textContent = '#' + channel.name + ' (' + channel.id + ')';
          select.appendChild(option);
        }
      }

      function renderMentionOptions() {
        const select = document.getElementById('mentionTargets');
        if (!(select instanceof HTMLSelectElement)) return;

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

        const mentionStatus = document.getElementById('mentionStatus');
        if (mentionStatus instanceof HTMLElement) {
          mentionStatus.textContent =
            '已載入標記候選：使用者 ' + slackOptions.loaded.users + '、群組 ' + slackOptions.loaded.usergroups;
        }
      }

      function renderSlackLoadStatus() {
        const channelStatus = document.getElementById('slackChannelStatus');
        if (channelStatus instanceof HTMLElement) {
          channelStatus.textContent = '已載入 Slack 頻道：' + slackOptions.loaded.channels;
        }

        const errorStatus = document.getElementById('slackErrorStatus');
        if (errorStatus instanceof HTMLElement) {
          errorStatus.textContent = slackOptions.errors.length
            ? 'Slack 下拉載入部分失敗：' + slackOptions.errors.join(' | ') + '（可先用手動輸入）'
            : '';
        }
      }

      function setCreateMode() {
        editingRuleId = null;
        const createBtn = document.getElementById('createBtn');
        if (createBtn instanceof HTMLButtonElement) {
          createBtn.textContent = '建立規則';
        }
        const cancelBtn = document.getElementById('cancelEditBtn');
        if (cancelBtn instanceof HTMLButtonElement) {
          cancelBtn.style.display = 'none';
        }

        const guildSelect = document.getElementById('guildSelect');
        if (guildSelect instanceof HTMLSelectElement) {
          guildSelect.value = '';
        }
        renderChannelOptions('');
        const channelSelect = document.getElementById('channelSelect');
        if (channelSelect instanceof HTMLSelectElement) {
          channelSelect.value = '';
        }

        const slackSelect = document.getElementById('slackChannelSelect');
        if (slackSelect instanceof HTMLSelectElement) {
          slackSelect.value = '';
        }

        const excludedInput = document.getElementById('excludedAuthorIds');
        if (excludedInput instanceof HTMLInputElement) {
          excludedInput.value = '';
        }
      }

      function renderGlobalSettings() {
        const input = document.getElementById('globalExcludedAuthorIds');
        if (input instanceof HTMLInputElement) {
          input.value = (relaySettings.globalExcludedAuthorIds || []).join(', ');
        }
      }

      function mergeIdsToInput(input, ids) {
        const current = input.value
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        const merged = Array.from(new Set(current.concat(ids)));
        input.value = merged.join(', ');
      }

      function renderExcludedAuthorOptions() {
        const globalSelect = document.getElementById('globalExcludedAuthorSelect');
        if (globalSelect instanceof HTMLSelectElement) {
          globalSelect.innerHTML = '';
          for (const author of recentDiscordAuthors) {
            const option = document.createElement('option');
            option.value = author.id;
            option.textContent = author.displayName + ' (' + author.id + ')';
            globalSelect.appendChild(option);
          }
        }

        const ruleSelect = document.getElementById('excludedAuthorSelect');
        if (ruleSelect instanceof HTMLSelectElement) {
          ruleSelect.innerHTML = '';
          for (const author of recentDiscordAuthors) {
            const option = document.createElement('option');
            option.value = author.id;
            option.textContent = author.displayName + ' (' + author.id + ')';
            ruleSelect.appendChild(option);
          }
        }
      }

      async function refreshExcludedAuthorOptions() {
        const guildInput = document.getElementById('guildId');
        const guildId = guildInput instanceof HTMLInputElement ? guildInput.value.trim() : '';
        recentDiscordAuthors = await fetchDiscordAuthors(guildId || undefined);
        renderExcludedAuthorOptions();
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

      function fillFormFromRule(rule) {
        const map = [
          ['name', rule.name],
          ['guildId', rule.sourceGuildId],
          ['channelId', rule.sourceChannelId],
          ['slackChannel', rule.targetSlackChannel],
        ];
        for (const [id, value] of map) {
          const input = document.getElementById(id);
          if (input instanceof HTMLInputElement) {
            input.value = value || '';
          }
        }

        const guildSelect = document.getElementById('guildSelect');
        if (guildSelect instanceof HTMLSelectElement) {
          guildSelect.value = rule.sourceGuildId || '';
        }

        renderChannelOptions(rule.sourceGuildId || '');

        const channelSelect = document.getElementById('channelSelect');
        if (channelSelect instanceof HTMLSelectElement) {
          channelSelect.value = rule.sourceChannelId || '';
        }

        const slackSelect = document.getElementById('slackChannelSelect');
        if (slackSelect instanceof HTMLSelectElement) {
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

        const enabled = document.getElementById('enabled');
        if (enabled instanceof HTMLInputElement) {
          enabled.checked = Boolean(rule.enabled);
        }

        const mentionTargets = new Set(rule.mentionTargets || []);
        const select = document.getElementById('mentionTargets');
        if (select instanceof HTMLSelectElement) {
          for (const option of select.options) {
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

        const custom = document.getElementById('mentionsCustom');
        if (custom instanceof HTMLInputElement) {
          custom.value = Array.from(mentionTargets).join(', ');
        }

        const excludedInput = document.getElementById('excludedAuthorIds');
        if (excludedInput instanceof HTMLInputElement) {
          excludedInput.value = (rule.excludedAuthorIds || []).join(', ');
        }

        const createBtn = document.getElementById('createBtn');
        if (createBtn instanceof HTMLButtonElement) {
          createBtn.textContent = '更新規則';
        }
        const cancelBtn = document.getElementById('cancelEditBtn');
        if (cancelBtn instanceof HTMLButtonElement) {
          cancelBtn.style.display = 'inline-block';
        }

        editingRuleId = rule.id;
        refreshExcludedAuthorOptions();
      }

      function renderGuildOptions() {
        const guildSelect = document.getElementById('guildSelect');
        if (!(guildSelect instanceof HTMLSelectElement)) return;

        guildSelect.innerHTML = '<option value="">手動輸入</option>';
        for (const guild of discordSources) {
          const option = document.createElement('option');
          option.value = guild.id;
          option.textContent = guild.name + ' (' + guild.id + ')';
          guildSelect.appendChild(option);
        }
      }

      function renderChannelOptions(guildId) {
        const channelSelect = document.getElementById('channelSelect');
        if (!(channelSelect instanceof HTMLSelectElement)) return;

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

      function collectMentionTargets() {
        const select = document.getElementById('mentionTargets');
        const customInput = document.getElementById('mentionsCustom');
        const targets = [];

        if (select instanceof HTMLSelectElement) {
          for (const option of select.selectedOptions) {
            const value = option.value.trim();
            if (value) targets.push(value);
          }
        }

        if (customInput instanceof HTMLInputElement) {
          const customTargets = customInput.value
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean);
          for (const target of customTargets) {
            targets.push(target);
          }
        }

        return Array.from(new Set(targets));
      }

      async function refreshRules() {
        const rules = await fetchRules();
        const rows = document.getElementById('ruleRows');
        rows.innerHTML = '';

        for (const rule of rules) {
          const slackTargetDisplay = getSlackChannelDisplay(rule.targetSlackChannel);
          const mentionDisplay = (rule.mentionTargets || [])
            .map((value) => getMentionDisplay(value))
            .filter(Boolean)
            .join(' ');
          const excludedDisplay = (rule.excludedAuthorIds || []).join(', ');
          const tr = document.createElement('tr');
          const checkedAttr = rule.enabled ? 'checked' : '';
          tr.innerHTML = [
            '<td>' + rule.name + '</td>',
            '<td><input type="checkbox" ' + checkedAttr + ' data-action="toggle" data-id="' + rule.id + '" /></td>',
            '<td>' + rule.sourceGuildId + ' / ' + rule.sourceChannelId + '</td>',
            '<td title="' + rule.targetSlackChannel + '">' + slackTargetDisplay + '</td>',
            '<td>' + mentionDisplay + '</td>',
            '<td>' + excludedDisplay + '</td>',
            '<td class="row-actions">',
            '<button class="secondary" data-action="edit" data-id="' + rule.id + '">編輯</button>',
            '<button class="secondary" data-action="delete" data-id="' + rule.id + '">刪除</button>',
            '</td>'
          ].join('');
          rows.appendChild(tr);
        }
      }

      document.getElementById('createBtn').addEventListener('click', async () => {
        const excludedInput = document.getElementById('excludedAuthorIds');
        const excludedAuthorIds = excludedInput instanceof HTMLInputElement
          ? excludedInput.value.split(',').map((value) => value.trim()).filter(Boolean)
          : [];

        const payload = {
          name: document.getElementById('name').value,
          sourceGuildId: document.getElementById('guildId').value,
          sourceChannelId: document.getElementById('channelId').value,
          targetSlackChannel: document.getElementById('slackChannel').value,
          mentionTargets: collectMentionTargets(),
          excludedAuthorIds,
          enabled: document.getElementById('enabled').checked,
        };

        const isEditMode = Boolean(editingRuleId);
        const endpoint = isEditMode
          ? '/api/admin/discord-rules/' + editingRuleId
          : '/api/admin/discord-rules';

        const res = await fetch(endpoint, {
          method: isEditMode ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          alert('建立規則失敗，請檢查欄位。');
          return;
        }

        if (!isEditMode) {
          document.getElementById('name').value = '';
          document.getElementById('guildId').value = '';
          document.getElementById('channelId').value = '';
          document.getElementById('slackChannel').value = '';
          document.getElementById('mentionsCustom').value = '';
          document.getElementById('excludedAuthorIds').value = '';
        }

        setCreateMode();
        await refreshRules();
      });

      document.getElementById('saveGlobalSettingsBtn').addEventListener('click', async () => {
        const input = document.getElementById('globalExcludedAuthorIds');
        const values = input instanceof HTMLInputElement
          ? input.value.split(',').map((value) => value.trim()).filter(Boolean)
          : [];

        try {
          relaySettings = await saveSettings({ globalExcludedAuthorIds: values });
          renderGlobalSettings();
          const status = document.getElementById('globalSettingsStatus');
          if (status instanceof HTMLElement) {
            status.textContent = '全域排除作者已儲存（執行期 union 立即生效）。';
          }
        } catch {
          const status = document.getElementById('globalSettingsStatus');
          if (status instanceof HTMLElement) {
            status.textContent = '儲存全域設定失敗，請稍後再試。';
          }
        }
      });

      document.getElementById('addGlobalExcludedAuthorBtn').addEventListener('click', () => {
        const select = document.getElementById('globalExcludedAuthorSelect');
        const input = document.getElementById('globalExcludedAuthorIds');
        if (!(select instanceof HTMLSelectElement) || !(input instanceof HTMLInputElement)) {
          return;
        }
        const ids = Array.from(select.selectedOptions)
          .map((option) => option.value.trim())
          .filter(Boolean);
        mergeIdsToInput(input, ids);
      });

      document.getElementById('addExcludedAuthorBtn').addEventListener('click', () => {
        const select = document.getElementById('excludedAuthorSelect');
        const input = document.getElementById('excludedAuthorIds');
        if (!(select instanceof HTMLSelectElement) || !(input instanceof HTMLInputElement)) {
          return;
        }
        const ids = Array.from(select.selectedOptions)
          .map((option) => option.value.trim())
          .filter(Boolean);
        mergeIdsToInput(input, ids);
      });

      document.getElementById('cancelEditBtn').addEventListener('click', () => {
        setCreateMode();
      });

      document.getElementById('guildSelect').addEventListener('change', (event) => {
        const select = event.target;
        if (!(select instanceof HTMLSelectElement)) return;

        const guildInput = document.getElementById('guildId');
        if (guildInput instanceof HTMLInputElement) {
          guildInput.value = select.value;
        }

        renderChannelOptions(select.value);
        refreshExcludedAuthorOptions();
      });

      document.getElementById('guildId').addEventListener('change', () => {
        refreshExcludedAuthorOptions();
      });

      document.getElementById('channelSelect').addEventListener('change', (event) => {
        const select = event.target;
        if (!(select instanceof HTMLSelectElement)) return;

        const channelInput = document.getElementById('channelId');
        if (channelInput instanceof HTMLInputElement) {
          channelInput.value = select.value;
        }
      });

      document.getElementById('slackChannelSelect').addEventListener('change', (event) => {
        const select = event.target;
        if (!(select instanceof HTMLSelectElement)) return;

        const channelInput = document.getElementById('slackChannel');
        if (channelInput instanceof HTMLInputElement) {
          channelInput.value = select.value;
        }
      });

      document.getElementById('ruleRows').addEventListener('click', async (event) => {
        const btn = event.target;
        if (!(btn instanceof HTMLElement)) return;

        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (!action || !id) return;

        if (action === 'edit') {
          const rules = await fetchRules();
          const target = rules.find((rule) => rule.id === id);
          if (target) {
            fillFormFromRule(target);
          }
          return;
        }

        if (action === 'delete') {
          await fetch('/api/admin/discord-rules/' + id, { method: 'DELETE' });
          await refreshRules();
        }
      });

      document.getElementById('ruleRows').addEventListener('change', async (event) => {
        const input = event.target;
        if (!(input instanceof HTMLInputElement)) return;

        if (input.dataset.action !== 'toggle' || !input.dataset.id) return;

        await fetch('/api/admin/discord-rules/' + input.dataset.id, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: input.checked }),
        });
        await refreshRules();
      });

      (async () => {
        discordSources = await fetchDiscordSources();
        slackOptions = await fetchSlackOptions();
        relaySettings = await fetchSettings();
        await refreshExcludedAuthorOptions();
        renderGuildOptions();
        renderSlackChannelOptions();
        renderMentionOptions();
        renderGlobalSettings();
        renderSlackLoadStatus();
        setCreateMode();
        await refreshRules();
      })();
    </script>
  </body>
</html>`);
});

export default router;
