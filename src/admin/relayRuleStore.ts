import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
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

export type RelayRuleImportMode = 'replace' | 'merge';

export const DEFAULT_SLACK_MESSAGE_TEMPLATE = [
  '{mentions}',
  '發訊者：{sender}',
  '內容：{content}',
  '',
  '【{platform}】{server} {channel}',
].join('\n');

function normalizeSlackMessageTemplate(value: unknown): string {
  if (typeof value !== 'string') {
    return DEFAULT_SLACK_MESSAGE_TEMPLATE;
  }
  return value.trim() ? value : DEFAULT_SLACK_MESSAGE_TEMPLATE;
}

export type RelayRuleExportData = {
  version: 1;
  exportedAt: string;
  discordRules: DiscordRelayRule[];
  lineRules: LineRelayRule[];
  globalExcludedAuthorIds: string[];
  globalExcludedAuthorProfiles: DiscordGlobalExcludedAuthorProfile[];
  globalExcludedAuthorRoleIds: string[];
  globalExcludedLineSpeakerIds: string[];
  globalExcludedLineSpeakerProfiles: LineGlobalExcludedSpeakerProfile[];
  discordMentionTrigger: DiscordMentionTriggerConfig;
  lineMentionTrigger: LineMentionTriggerConfig;
  mentionDirectory: MentionDirectoryConfig;
  slackMessageTemplate: string;
};

type RelayRuleStoreData = {
  discordRules: DiscordRelayRule[];
  lineRules: LineRelayRule[];
  globalExcludedAuthorIds: string[];
  globalExcludedAuthorProfiles: DiscordGlobalExcludedAuthorProfile[];
  globalExcludedAuthorRoleIds: string[];
  globalExcludedLineSpeakerIds: string[];
  globalExcludedLineSpeakerProfiles: LineGlobalExcludedSpeakerProfile[];
  discordMentionTrigger: DiscordMentionTriggerConfig;
  lineMentionTrigger: LineMentionTriggerConfig;
  mentionDirectory: MentionDirectoryConfig;
  slackMessageTemplate: string;
};

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'relay-rules.json');

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function normalizeDiscordMentionMapping(value: unknown): DiscordMentionMapping | null {
  const raw = value as Partial<DiscordMentionMapping> | null;
  if (!raw || !raw.discordUserId || !raw.slackMention) {
    return null;
  }

  return {
    id: raw.id ? String(raw.id) : crypto.randomUUID(),
    enabled: Boolean(raw.enabled ?? true),
    discordUserId: String(raw.discordUserId).trim(),
    slackMention: String(raw.slackMention).trim(),
    label: String(raw.label ?? raw.discordUserId).trim(),
  };
}

function normalizeLineMentionMapping(value: unknown): LineMentionMapping | null {
  const raw = value as Partial<LineMentionMapping> | null;
  if (!raw || !raw.lineUserId || !raw.slackMention) {
    return null;
  }

  return {
    id: raw.id ? String(raw.id) : crypto.randomUUID(),
    enabled: Boolean(raw.enabled ?? true),
    lineUserId: String(raw.lineUserId).trim(),
    lineChannelId: raw.lineChannelId ? String(raw.lineChannelId).trim() : 'default',
    slackMention: String(raw.slackMention).trim(),
    label: String(raw.label ?? raw.lineUserId).trim(),
  };
}

function normalizeDiscordMentionTrigger(value: unknown): DiscordMentionTriggerConfig {
  const raw = value as Partial<DiscordMentionTriggerConfig> | null;
  const mappings = Array.isArray(raw?.mappings)
    ? raw.mappings.map((item) => normalizeDiscordMentionMapping(item)).filter(Boolean) as DiscordMentionMapping[]
    : [];

  return {
    enabled: Boolean(raw?.enabled ?? false),
    allowedGuildIds: normalizeStringArray(raw?.allowedGuildIds),
    mappings,
  };
}

function normalizeLineMentionTrigger(value: unknown): LineMentionTriggerConfig {
  const raw = value as Partial<LineMentionTriggerConfig> | null;
  const mappings = Array.isArray(raw?.mappings)
    ? raw.mappings.map((item) => normalizeLineMentionMapping(item)).filter(Boolean) as LineMentionMapping[]
    : [];

  return {
    enabled: Boolean(raw?.enabled ?? false),
    allowedGroupIds: normalizeStringArray(raw?.allowedGroupIds),
    excludedGroupIds: normalizeStringArray(raw?.excludedGroupIds),
    mappings,
  };
}

function normalizeSlackMentionIdentity(value: unknown): SlackMentionIdentity | null {
  const raw = value as Partial<SlackMentionIdentity> | null;
  if (!raw || !raw.slackMention) {
    return null;
  }

  const discordUserIds = Array.isArray(raw.discordUserIds)
    ? raw.discordUserIds.map((item) => String(item).trim()).filter(Boolean)
    : [];

  const lineUserIds = Array.isArray(raw.lineUserIds)
    ? raw.lineUserIds.map((item) => String(item).trim()).filter(Boolean)
    : [];

  return {
    id: raw.id ? String(raw.id) : crypto.randomUUID(),
    enabled: Boolean(raw.enabled ?? true),
    label: String(raw.label ?? raw.slackMention).trim(),
    slackMention: String(raw.slackMention).trim(),
    discordUserIds,
    lineUserIds,
  };
}

function normalizeMentionDirectory(value: unknown): MentionDirectoryConfig {
  const raw = value as Partial<MentionDirectoryConfig> | null;
  const identities = Array.isArray(raw?.identities)
    ? raw.identities
      .map((item) => normalizeSlackMentionIdentity(item))
      .filter(Boolean) as SlackMentionIdentity[]
    : [];

  return { identities };
}

function normalizeDiscordGlobalExcludedAuthorProfiles(value: unknown): DiscordGlobalExcludedAuthorProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const dedup = new Map<string, DiscordGlobalExcludedAuthorProfile>();
  for (const item of value) {
    const raw = item as Partial<DiscordGlobalExcludedAuthorProfile> | null;
    const discordUserId = String(raw?.discordUserId ?? '').trim();
    if (!discordUserId) {
      continue;
    }

    const note = String(raw?.note ?? '').trim();
    const slackMention = String(raw?.slackMention ?? '').trim();
    dedup.set(discordUserId, {
      discordUserId,
      note,
      slackMention: slackMention || undefined,
    });
  }

  return Array.from(dedup.values());
}

function normalizeLineGlobalExcludedSpeakerProfiles(value: unknown): LineGlobalExcludedSpeakerProfile[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const dedup = new Map<string, LineGlobalExcludedSpeakerProfile>();
  for (const item of value) {
    const raw = item as Partial<LineGlobalExcludedSpeakerProfile> | null;
    const lineUserId = String(raw?.lineUserId ?? '').trim();
    if (!lineUserId) {
      continue;
    }

    const note = String(raw?.note ?? '').trim();
    const slackMention = String(raw?.slackMention ?? '').trim();
    dedup.set(lineUserId, {
      lineUserId,
      note,
      slackMention: slackMention || undefined,
    });
  }

  return Array.from(dedup.values());
}

function normalizeDiscordRuleForImport(value: unknown, preserveId: boolean): DiscordRelayRule | null {
  const raw = value as Partial<DiscordRelayRule> | null;
  if (!raw || !raw.name || !raw.sourceGuildId || !raw.targetSlackChannel) {
    return null;
  }

  return {
    id: preserveId && raw.id ? String(raw.id) : crypto.randomUUID(),
    name: String(raw.name).trim(),
    enabled: Boolean(raw.enabled ?? true),
    sourceGuildId: String(raw.sourceGuildId).trim(),
    sourceChannelId: String(raw.sourceChannelId ?? '').trim(),
    targetSlackChannel: String(raw.targetSlackChannel).trim(),
    mentionTargets: normalizeStringArray(raw.mentionTargets),
    excludedAuthorIds: normalizeStringArray(raw.excludedAuthorIds),
    excludedAuthorRoleIds: normalizeStringArray(raw.excludedAuthorRoleIds),
  };
}

function normalizeLineRuleForImport(value: unknown, preserveId: boolean): LineRelayRule | null {
  const raw = value as Partial<LineRelayRule> | null;
  if (!raw || !raw.name || !raw.sourceGroupId || !raw.targetSlackChannel) {
    return null;
  }

  return {
    id: preserveId && raw.id ? String(raw.id) : crypto.randomUUID(),
    name: String(raw.name).trim(),
    enabled: Boolean(raw.enabled ?? true),
    sourceGroupId: String(raw.sourceGroupId).trim(),
    targetSlackChannel: String(raw.targetSlackChannel).trim(),
    mentionTargets: normalizeStringArray(raw.mentionTargets),
    excludedSpeakerIds: normalizeStringArray(raw.excludedSpeakerIds),
  };
}

async function ensureStoreFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DATA_FILE);
  } catch {
    const initialData: RelayRuleStoreData = {
      discordRules: [],
      lineRules: [],
      globalExcludedAuthorIds: [],
      globalExcludedAuthorProfiles: [],
      globalExcludedAuthorRoleIds: [],
      globalExcludedLineSpeakerIds: [],
      globalExcludedLineSpeakerProfiles: [],
      discordMentionTrigger: {
        enabled: false,
        allowedGuildIds: [],
        mappings: [],
      },
      lineMentionTrigger: {
        enabled: false,
        allowedGroupIds: [],
        excludedGroupIds: [],
        mappings: [],
      },
      mentionDirectory: {
        identities: [],
      },
      slackMessageTemplate: DEFAULT_SLACK_MESSAGE_TEMPLATE,
    };
    await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

async function readStore(): Promise<RelayRuleStoreData> {
  await ensureStoreFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw) as Partial<RelayRuleStoreData>;

  const rawRules = Array.isArray(parsed.discordRules) ? parsed.discordRules : [];
  const rawLineRules = Array.isArray(parsed.lineRules) ? parsed.lineRules : [];

  const discordRules: DiscordRelayRule[] = rawRules.map((item) => {
    const raw = item as DiscordRelayRule & { defaultMentions?: string };
    const mentionTargets = Array.isArray(raw.mentionTargets)
      ? raw.mentionTargets.map((value) => String(value).trim()).filter(Boolean)
      : typeof raw.defaultMentions === 'string' && raw.defaultMentions.trim()
        ? [raw.defaultMentions.trim()]
        : [];

    return {
      id: String(raw.id),
      name: String(raw.name),
      enabled: Boolean(raw.enabled),
      sourceGuildId: String(raw.sourceGuildId),
      sourceChannelId: String(raw.sourceChannelId ?? ''),
      targetSlackChannel: String(raw.targetSlackChannel),
      mentionTargets,
      excludedAuthorIds: Array.isArray(raw.excludedAuthorIds)
        ? raw.excludedAuthorIds.map((value) => String(value).trim()).filter(Boolean)
        : [],
      excludedAuthorRoleIds: Array.isArray(raw.excludedAuthorRoleIds)
        ? raw.excludedAuthorRoleIds.map((value) => String(value).trim()).filter(Boolean)
        : [],
    };
  });

  const globalExcludedAuthorIds = Array.isArray(parsed.globalExcludedAuthorIds)
    ? parsed.globalExcludedAuthorIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  const globalExcludedAuthorProfiles = normalizeDiscordGlobalExcludedAuthorProfiles(parsed.globalExcludedAuthorProfiles);

  const globalExcludedAuthorRoleIds = Array.isArray(parsed.globalExcludedAuthorRoleIds)
    ? parsed.globalExcludedAuthorRoleIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  const globalExcludedLineSpeakerIds = Array.isArray(parsed.globalExcludedLineSpeakerIds)
    ? parsed.globalExcludedLineSpeakerIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  const globalExcludedLineSpeakerProfiles = normalizeLineGlobalExcludedSpeakerProfiles(parsed.globalExcludedLineSpeakerProfiles);

  const lineRules: LineRelayRule[] = rawLineRules.map((item) => {
    const raw = item as LineRelayRule & { defaultMentions?: string };
    const mentionTargets = Array.isArray(raw.mentionTargets)
      ? raw.mentionTargets.map((value) => String(value).trim()).filter(Boolean)
      : typeof raw.defaultMentions === 'string' && raw.defaultMentions.trim()
        ? [raw.defaultMentions.trim()]
        : [];

    return {
      id: String(raw.id),
      name: String(raw.name),
      enabled: Boolean(raw.enabled),
      sourceGroupId: String(raw.sourceGroupId),
      targetSlackChannel: String(raw.targetSlackChannel),
      mentionTargets,
      excludedSpeakerIds: Array.isArray(raw.excludedSpeakerIds)
        ? raw.excludedSpeakerIds.map((value) => String(value).trim()).filter(Boolean)
        : [],
    };
  });

  return {
    discordRules,
    lineRules,
    globalExcludedAuthorIds,
    globalExcludedAuthorProfiles,
    globalExcludedAuthorRoleIds,
    globalExcludedLineSpeakerIds,
    globalExcludedLineSpeakerProfiles,
    discordMentionTrigger: normalizeDiscordMentionTrigger(parsed.discordMentionTrigger),
    lineMentionTrigger: normalizeLineMentionTrigger(parsed.lineMentionTrigger),
    mentionDirectory: normalizeMentionDirectory(parsed.mentionDirectory),
    slackMessageTemplate: normalizeSlackMessageTemplate(parsed.slackMessageTemplate),
  };
}

async function writeStore(data: RelayRuleStoreData): Promise<void> {
  await ensureStoreFile();
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export async function getDiscordRelayRules(): Promise<DiscordRelayRule[]> {
  const store = await readStore();
  return store.discordRules;
}

export async function getRelaySettings(): Promise<{
  globalExcludedAuthorIds: string[];
  globalExcludedAuthorProfiles: DiscordGlobalExcludedAuthorProfile[];
  globalExcludedAuthorRoleIds: string[];
  globalExcludedLineSpeakerIds: string[];
  globalExcludedLineSpeakerProfiles: LineGlobalExcludedSpeakerProfile[];
  discordMentionTrigger: DiscordMentionTriggerConfig;
  lineMentionTrigger: LineMentionTriggerConfig;
  mentionDirectory: MentionDirectoryConfig;
  slackMessageTemplate: string;
}> {
  const store = await readStore();
  return {
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
    globalExcludedAuthorProfiles: store.globalExcludedAuthorProfiles,
    globalExcludedAuthorRoleIds: store.globalExcludedAuthorRoleIds,
    globalExcludedLineSpeakerIds: store.globalExcludedLineSpeakerIds,
    globalExcludedLineSpeakerProfiles: store.globalExcludedLineSpeakerProfiles,
    discordMentionTrigger: store.discordMentionTrigger,
    lineMentionTrigger: store.lineMentionTrigger,
    mentionDirectory: store.mentionDirectory,
    slackMessageTemplate: store.slackMessageTemplate,
  };
}

export async function getLineRelayRules(): Promise<LineRelayRule[]> {
  const store = await readStore();
  return store.lineRules;
}

export async function updateRelaySettings(patch: {
  globalExcludedAuthorIds?: string[];
  globalExcludedAuthorProfiles?: DiscordGlobalExcludedAuthorProfile[];
  globalExcludedAuthorRoleIds?: string[];
  globalExcludedLineSpeakerIds?: string[];
  globalExcludedLineSpeakerProfiles?: LineGlobalExcludedSpeakerProfile[];
  discordMentionTrigger?: Partial<DiscordMentionTriggerConfig>;
  lineMentionTrigger?: Partial<LineMentionTriggerConfig>;
  mentionDirectory?: Partial<MentionDirectoryConfig>;
  slackMessageTemplate?: string;
}): Promise<{
  globalExcludedAuthorIds: string[];
  globalExcludedAuthorProfiles: DiscordGlobalExcludedAuthorProfile[];
  globalExcludedAuthorRoleIds: string[];
  globalExcludedLineSpeakerIds: string[];
  globalExcludedLineSpeakerProfiles: LineGlobalExcludedSpeakerProfile[];
  discordMentionTrigger: DiscordMentionTriggerConfig;
  lineMentionTrigger: LineMentionTriggerConfig;
  mentionDirectory: MentionDirectoryConfig;
  slackMessageTemplate: string;
}> {
  const store = await readStore();

  if (Array.isArray(patch.globalExcludedAuthorIds)) {
    store.globalExcludedAuthorIds = patch.globalExcludedAuthorIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  if (Array.isArray(patch.globalExcludedAuthorProfiles)) {
    store.globalExcludedAuthorProfiles = normalizeDiscordGlobalExcludedAuthorProfiles(patch.globalExcludedAuthorProfiles);
  }

  if (Array.isArray(patch.globalExcludedAuthorRoleIds)) {
    store.globalExcludedAuthorRoleIds = patch.globalExcludedAuthorRoleIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  if (Array.isArray(patch.globalExcludedLineSpeakerIds)) {
    store.globalExcludedLineSpeakerIds = patch.globalExcludedLineSpeakerIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  if (Array.isArray(patch.globalExcludedLineSpeakerProfiles)) {
    store.globalExcludedLineSpeakerProfiles = normalizeLineGlobalExcludedSpeakerProfiles(patch.globalExcludedLineSpeakerProfiles);
  }

  if (patch.discordMentionTrigger) {
    const next = {
      ...store.discordMentionTrigger,
      ...patch.discordMentionTrigger,
    };
    store.discordMentionTrigger = normalizeDiscordMentionTrigger(next);
  }

  if (patch.lineMentionTrigger) {
    const next = {
      ...store.lineMentionTrigger,
      ...patch.lineMentionTrigger,
    };
    store.lineMentionTrigger = normalizeLineMentionTrigger(next);
  }

  if (patch.mentionDirectory) {
    const next = {
      ...store.mentionDirectory,
      ...patch.mentionDirectory,
    };
    store.mentionDirectory = normalizeMentionDirectory(next);
  }

  if (typeof patch.slackMessageTemplate === 'string') {
    store.slackMessageTemplate = normalizeSlackMessageTemplate(patch.slackMessageTemplate);
  }

  await writeStore(store);

  return {
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
    globalExcludedAuthorProfiles: store.globalExcludedAuthorProfiles,
    globalExcludedAuthorRoleIds: store.globalExcludedAuthorRoleIds,
    globalExcludedLineSpeakerIds: store.globalExcludedLineSpeakerIds,
    globalExcludedLineSpeakerProfiles: store.globalExcludedLineSpeakerProfiles,
    discordMentionTrigger: store.discordMentionTrigger,
    lineMentionTrigger: store.lineMentionTrigger,
    mentionDirectory: store.mentionDirectory,
    slackMessageTemplate: store.slackMessageTemplate,
  };
}

export async function exportRelayRules(): Promise<RelayRuleExportData> {
  const store = await readStore();
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    discordRules: store.discordRules,
    lineRules: store.lineRules,
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
    globalExcludedAuthorProfiles: store.globalExcludedAuthorProfiles,
    globalExcludedAuthorRoleIds: store.globalExcludedAuthorRoleIds,
    globalExcludedLineSpeakerIds: store.globalExcludedLineSpeakerIds,
    globalExcludedLineSpeakerProfiles: store.globalExcludedLineSpeakerProfiles,
    discordMentionTrigger: store.discordMentionTrigger,
    lineMentionTrigger: store.lineMentionTrigger,
    mentionDirectory: store.mentionDirectory,
    slackMessageTemplate: store.slackMessageTemplate,
  };
}

export async function importRelayRules(
  payload: unknown,
  mode: RelayRuleImportMode,
): Promise<{
  discordRules: number;
  lineRules: number;
  globalExcludedAuthorIds: number;
  globalExcludedAuthorProfiles: number;
  globalExcludedAuthorRoleIds: number;
  globalExcludedLineSpeakerIds: number;
  globalExcludedLineSpeakerProfiles: number;
  discordMentionMappings: number;
  lineMentionMappings: number;
  mentionDirectoryIdentities: number;
}> {
  const raw = payload as Partial<RelayRuleStoreData> | null;
  if (!raw || !Array.isArray(raw.discordRules) || !Array.isArray(raw.lineRules)) {
    throw new Error('Invalid relay rule import payload.');
  }

  const preserveId = mode === 'replace';
  const discordRules = raw.discordRules.map((rule) => normalizeDiscordRuleForImport(rule, preserveId));
  const lineRules = raw.lineRules.map((rule) => normalizeLineRuleForImport(rule, preserveId));

  if (discordRules.some((rule) => rule === null) || lineRules.some((rule) => rule === null)) {
    throw new Error('Import file contains invalid relay rules.');
  }

  const globalExcludedAuthorIds = normalizeStringArray(raw.globalExcludedAuthorIds);
  const globalExcludedAuthorProfiles = normalizeDiscordGlobalExcludedAuthorProfiles(raw.globalExcludedAuthorProfiles);
  const globalExcludedAuthorRoleIds = normalizeStringArray(raw.globalExcludedAuthorRoleIds);
  const globalExcludedLineSpeakerIds = normalizeStringArray(raw.globalExcludedLineSpeakerIds);
  const globalExcludedLineSpeakerProfiles = normalizeLineGlobalExcludedSpeakerProfiles(raw.globalExcludedLineSpeakerProfiles);
  const discordMentionTrigger = normalizeDiscordMentionTrigger(raw.discordMentionTrigger);
  const lineMentionTrigger = normalizeLineMentionTrigger(raw.lineMentionTrigger);
  const mentionDirectory = normalizeMentionDirectory(raw.mentionDirectory);
  const store = mode === 'merge'
    ? await readStore()
    : {
      discordRules: [],
      lineRules: [],
      globalExcludedAuthorIds: [],
      globalExcludedAuthorProfiles: [],
      globalExcludedAuthorRoleIds: [],
      globalExcludedLineSpeakerIds: [],
      globalExcludedLineSpeakerProfiles: [],
      discordMentionTrigger: { enabled: false, allowedGuildIds: [], mappings: [] },
      lineMentionTrigger: { enabled: false, allowedGroupIds: [], excludedGroupIds: [], mappings: [] },
      mentionDirectory: { identities: [] },
      slackMessageTemplate: DEFAULT_SLACK_MESSAGE_TEMPLATE,
    };

  store.discordRules = store.discordRules.concat(discordRules as DiscordRelayRule[]);
  store.lineRules = store.lineRules.concat(lineRules as LineRelayRule[]);
  store.globalExcludedAuthorIds = Array.from(new Set(
    mode === 'merge'
      ? store.globalExcludedAuthorIds.concat(globalExcludedAuthorIds)
      : globalExcludedAuthorIds,
  ));
  store.globalExcludedAuthorProfiles = normalizeDiscordGlobalExcludedAuthorProfiles(
    mode === 'merge'
      ? store.globalExcludedAuthorProfiles.concat(globalExcludedAuthorProfiles)
      : globalExcludedAuthorProfiles,
  );
  store.globalExcludedAuthorRoleIds = Array.from(new Set(
    mode === 'merge'
      ? store.globalExcludedAuthorRoleIds.concat(globalExcludedAuthorRoleIds)
      : globalExcludedAuthorRoleIds,
  ));
  store.globalExcludedLineSpeakerIds = Array.from(new Set(
    mode === 'merge'
      ? store.globalExcludedLineSpeakerIds.concat(globalExcludedLineSpeakerIds)
      : globalExcludedLineSpeakerIds,
  ));
  store.globalExcludedLineSpeakerProfiles = normalizeLineGlobalExcludedSpeakerProfiles(
    mode === 'merge'
      ? store.globalExcludedLineSpeakerProfiles.concat(globalExcludedLineSpeakerProfiles)
      : globalExcludedLineSpeakerProfiles,
  );

  if (mode === 'merge') {
    store.discordMentionTrigger = normalizeDiscordMentionTrigger({
      enabled: store.discordMentionTrigger.enabled || discordMentionTrigger.enabled,
      allowedGuildIds: Array.from(new Set(store.discordMentionTrigger.allowedGuildIds.concat(discordMentionTrigger.allowedGuildIds))),
      mappings: store.discordMentionTrigger.mappings.concat(discordMentionTrigger.mappings),
    });
    store.lineMentionTrigger = normalizeLineMentionTrigger({
      enabled: store.lineMentionTrigger.enabled || lineMentionTrigger.enabled,
      allowedGroupIds: Array.from(new Set(store.lineMentionTrigger.allowedGroupIds.concat(lineMentionTrigger.allowedGroupIds))),
      excludedGroupIds: Array.from(new Set(store.lineMentionTrigger.excludedGroupIds.concat(lineMentionTrigger.excludedGroupIds))),
      mappings: store.lineMentionTrigger.mappings.concat(lineMentionTrigger.mappings),
    });
  } else {
    store.discordMentionTrigger = discordMentionTrigger;
    store.lineMentionTrigger = lineMentionTrigger;
  }

  if (mode === 'merge') {
    store.mentionDirectory = normalizeMentionDirectory({
      identities: store.mentionDirectory.identities.concat(mentionDirectory.identities),
    });
  } else {
    store.mentionDirectory = mentionDirectory;
  }

  if (typeof raw.slackMessageTemplate === 'string' && raw.slackMessageTemplate.trim()) {
    store.slackMessageTemplate = normalizeSlackMessageTemplate(raw.slackMessageTemplate);
  } else if (mode === 'replace') {
    store.slackMessageTemplate = DEFAULT_SLACK_MESSAGE_TEMPLATE;
  }

  await writeStore(store);

  return {
    discordRules: discordRules.length,
    lineRules: lineRules.length,
    globalExcludedAuthorIds: globalExcludedAuthorIds.length,
    globalExcludedAuthorProfiles: globalExcludedAuthorProfiles.length,
    globalExcludedAuthorRoleIds: globalExcludedAuthorRoleIds.length,
    globalExcludedLineSpeakerIds: globalExcludedLineSpeakerIds.length,
    globalExcludedLineSpeakerProfiles: globalExcludedLineSpeakerProfiles.length,
    discordMentionMappings: discordMentionTrigger.mappings.length,
    lineMentionMappings: lineMentionTrigger.mappings.length,
    mentionDirectoryIdentities: mentionDirectory.identities.length,
  };
}

export async function getDiscordRelayRuntimeConfig(): Promise<{
  rules: DiscordRelayRule[];
  globalExcludedAuthorIds: string[];
  globalExcludedAuthorRoleIds: string[];
}> {
  const store = await readStore();
  return {
    rules: store.discordRules,
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
    globalExcludedAuthorRoleIds: store.globalExcludedAuthorRoleIds,
  };
}

export async function getLineRelayRuntimeConfig(): Promise<{
  rules: LineRelayRule[];
  globalExcludedLineSpeakerIds: string[];
}> {
  const store = await readStore();
  return {
    rules: store.lineRules,
    globalExcludedLineSpeakerIds: store.globalExcludedLineSpeakerIds,
  };
}

export async function getMentionTriggerRuntimeConfig(): Promise<{
  discordMentionTrigger: DiscordMentionTriggerConfig;
  lineMentionTrigger: LineMentionTriggerConfig;
  mentionDirectory: MentionDirectoryConfig;
}> {
  const store = await readStore();
  return {
    discordMentionTrigger: store.discordMentionTrigger,
    lineMentionTrigger: store.lineMentionTrigger,
    mentionDirectory: store.mentionDirectory,
  };
}

export async function createDiscordRelayRule(
  payload: Omit<DiscordRelayRule, 'id'>,
): Promise<DiscordRelayRule> {
  const store = await readStore();

  const rule: DiscordRelayRule = {
    id: crypto.randomUUID(),
    ...payload,
  };

  store.discordRules.push(rule);
  await writeStore(store);
  return rule;
}

export async function updateDiscordRelayRule(
  id: string,
  patch: Partial<Omit<DiscordRelayRule, 'id'>>,
): Promise<DiscordRelayRule | null> {
  const store = await readStore();
  const idx = store.discordRules.findIndex((r) => r.id === id);

  if (idx === -1) {
    return null;
  }

  store.discordRules[idx] = {
    ...store.discordRules[idx],
    ...patch,
    id,
  };

  await writeStore(store);
  return store.discordRules[idx];
}

export async function deleteDiscordRelayRule(id: string): Promise<boolean> {
  const store = await readStore();
  const before = store.discordRules.length;
  store.discordRules = store.discordRules.filter((r) => r.id !== id);

  if (store.discordRules.length === before) {
    return false;
  }

  await writeStore(store);
  return true;
}

export async function createLineRelayRule(
  payload: Omit<LineRelayRule, 'id'>,
): Promise<LineRelayRule> {
  const store = await readStore();

  const rule: LineRelayRule = {
    id: crypto.randomUUID(),
    ...payload,
  };

  store.lineRules.push(rule);
  await writeStore(store);
  return rule;
}

export async function updateLineRelayRule(
  id: string,
  patch: Partial<Omit<LineRelayRule, 'id'>>,
): Promise<LineRelayRule | null> {
  const store = await readStore();
  const idx = store.lineRules.findIndex((r) => r.id === id);

  if (idx === -1) {
    return null;
  }

  store.lineRules[idx] = {
    ...store.lineRules[idx],
    ...patch,
    id,
  };

  await writeStore(store);
  return store.lineRules[idx];
}

export async function deleteLineRelayRule(id: string): Promise<boolean> {
  const store = await readStore();
  const before = store.lineRules.length;
  store.lineRules = store.lineRules.filter((r) => r.id !== id);

  if (store.lineRules.length === before) {
    return false;
  }

  await writeStore(store);
  return true;
}
