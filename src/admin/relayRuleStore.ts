import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DiscordRelayRule, LineRelayRule } from '../types.js';

export type RelayRuleImportMode = 'replace' | 'merge';

export type RelayRuleExportData = {
  version: 1;
  exportedAt: string;
  discordRules: DiscordRelayRule[];
  lineRules: LineRelayRule[];
  globalExcludedAuthorIds: string[];
  globalExcludedLineSpeakerIds: string[];
};

type RelayRuleStoreData = {
  discordRules: DiscordRelayRule[];
  lineRules: LineRelayRule[];
  globalExcludedAuthorIds: string[];
  globalExcludedLineSpeakerIds: string[];
};

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'relay-rules.json');

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item).trim()).filter(Boolean)
    : [];
}

function normalizeDiscordRuleForImport(value: unknown, preserveId: boolean): DiscordRelayRule | null {
  const raw = value as Partial<DiscordRelayRule> | null;
  if (!raw || !raw.name || !raw.sourceGuildId || !raw.sourceChannelId || !raw.targetSlackChannel) {
    return null;
  }

  return {
    id: preserveId && raw.id ? String(raw.id) : crypto.randomUUID(),
    name: String(raw.name).trim(),
    enabled: Boolean(raw.enabled ?? true),
    sourceGuildId: String(raw.sourceGuildId).trim(),
    sourceChannelId: String(raw.sourceChannelId).trim(),
    targetSlackChannel: String(raw.targetSlackChannel).trim(),
    mentionTargets: normalizeStringArray(raw.mentionTargets),
    excludedAuthorIds: normalizeStringArray(raw.excludedAuthorIds),
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
      globalExcludedLineSpeakerIds: [],
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
      sourceChannelId: String(raw.sourceChannelId),
      targetSlackChannel: String(raw.targetSlackChannel),
      mentionTargets,
      excludedAuthorIds: Array.isArray(raw.excludedAuthorIds)
        ? raw.excludedAuthorIds.map((value) => String(value).trim()).filter(Boolean)
        : [],
    };
  });

  const globalExcludedAuthorIds = Array.isArray(parsed.globalExcludedAuthorIds)
    ? parsed.globalExcludedAuthorIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

  const globalExcludedLineSpeakerIds = Array.isArray(parsed.globalExcludedLineSpeakerIds)
    ? parsed.globalExcludedLineSpeakerIds.map((value) => String(value).trim()).filter(Boolean)
    : [];

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

  return { discordRules, lineRules, globalExcludedAuthorIds, globalExcludedLineSpeakerIds };
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
  globalExcludedLineSpeakerIds: string[];
}> {
  const store = await readStore();
  return {
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
    globalExcludedLineSpeakerIds: store.globalExcludedLineSpeakerIds,
  };
}

export async function getLineRelayRules(): Promise<LineRelayRule[]> {
  const store = await readStore();
  return store.lineRules;
}

export async function updateRelaySettings(patch: {
  globalExcludedAuthorIds?: string[];
  globalExcludedLineSpeakerIds?: string[];
}): Promise<{
  globalExcludedAuthorIds: string[];
  globalExcludedLineSpeakerIds: string[];
}> {
  const store = await readStore();

  if (Array.isArray(patch.globalExcludedAuthorIds)) {
    store.globalExcludedAuthorIds = patch.globalExcludedAuthorIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  if (Array.isArray(patch.globalExcludedLineSpeakerIds)) {
    store.globalExcludedLineSpeakerIds = patch.globalExcludedLineSpeakerIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  await writeStore(store);

  return {
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
    globalExcludedLineSpeakerIds: store.globalExcludedLineSpeakerIds,
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
    globalExcludedLineSpeakerIds: store.globalExcludedLineSpeakerIds,
  };
}

export async function importRelayRules(
  payload: unknown,
  mode: RelayRuleImportMode,
): Promise<{
  discordRules: number;
  lineRules: number;
  globalExcludedAuthorIds: number;
  globalExcludedLineSpeakerIds: number;
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
  const globalExcludedLineSpeakerIds = normalizeStringArray(raw.globalExcludedLineSpeakerIds);
  const store = mode === 'merge'
    ? await readStore()
    : { discordRules: [], lineRules: [], globalExcludedAuthorIds: [], globalExcludedLineSpeakerIds: [] };

  store.discordRules = store.discordRules.concat(discordRules as DiscordRelayRule[]);
  store.lineRules = store.lineRules.concat(lineRules as LineRelayRule[]);
  store.globalExcludedAuthorIds = Array.from(new Set(
    mode === 'merge'
      ? store.globalExcludedAuthorIds.concat(globalExcludedAuthorIds)
      : globalExcludedAuthorIds,
  ));
  store.globalExcludedLineSpeakerIds = Array.from(new Set(
    mode === 'merge'
      ? store.globalExcludedLineSpeakerIds.concat(globalExcludedLineSpeakerIds)
      : globalExcludedLineSpeakerIds,
  ));

  await writeStore(store);

  return {
    discordRules: discordRules.length,
    lineRules: lineRules.length,
    globalExcludedAuthorIds: globalExcludedAuthorIds.length,
    globalExcludedLineSpeakerIds: globalExcludedLineSpeakerIds.length,
  };
}

export async function getDiscordRelayRuntimeConfig(): Promise<{
  rules: DiscordRelayRule[];
  globalExcludedAuthorIds: string[];
}> {
  const store = await readStore();
  return {
    rules: store.discordRules,
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
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
