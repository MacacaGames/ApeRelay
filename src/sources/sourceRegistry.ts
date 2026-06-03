import { discordSourceAdapter } from './discordSource.js';
import { lineSourceAdapter } from './lineSource.js';
import type { SourceAdapter } from './types.js';

const adapters: SourceAdapter[] = [discordSourceAdapter, lineSourceAdapter];

export async function startAllSources(): Promise<void> {
  for (const adapter of adapters) {
    await adapter.start();
  }
}

export function getRegisteredSourceKeys(): string[] {
  return adapters.map((adapter) => adapter.key);
}
