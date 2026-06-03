import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DiscordRelayRule } from '../types.js';

type RelayRuleStoreData = {
  discordRules: DiscordRelayRule[];
  globalExcludedAuthorIds: string[];
};

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'relay-rules.json');

async function ensureStoreFile(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
    await fs.access(DATA_FILE);
  } catch {
    const initialData: RelayRuleStoreData = {
      discordRules: [],
      globalExcludedAuthorIds: [],
    };
    await fs.writeFile(DATA_FILE, JSON.stringify(initialData, null, 2), 'utf8');
  }
}

async function readStore(): Promise<RelayRuleStoreData> {
  await ensureStoreFile();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw) as Partial<RelayRuleStoreData>;

  const rawRules = Array.isArray(parsed.discordRules) ? parsed.discordRules : [];

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

  return { discordRules, globalExcludedAuthorIds };
}

async function writeStore(data: RelayRuleStoreData): Promise<void> {
  await ensureStoreFile();
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

export async function getDiscordRelayRules(): Promise<DiscordRelayRule[]> {
  const store = await readStore();
  return store.discordRules;
}

export async function getRelaySettings(): Promise<{ globalExcludedAuthorIds: string[] }> {
  const store = await readStore();
  return {
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
  };
}

export async function updateRelaySettings(patch: {
  globalExcludedAuthorIds?: string[];
}): Promise<{ globalExcludedAuthorIds: string[] }> {
  const store = await readStore();

  if (Array.isArray(patch.globalExcludedAuthorIds)) {
    store.globalExcludedAuthorIds = patch.globalExcludedAuthorIds
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  await writeStore(store);

  return {
    globalExcludedAuthorIds: store.globalExcludedAuthorIds,
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
