import { Client, validateSignature, type WebhookEvent } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { relayIncomingMessage } from '../core/relayPipeline.js';
import { logger } from '../logger.js';
import { normalizeLineEvent } from '../normalizer/lineNormalizer.js';
import type { SourceAdapter } from './types.js';

type RawBodyRequest = Request & { rawBody?: Buffer };
type LineSource = WebhookEvent['source'];
type LineGroupOption = {
  id: string;
  name: string;
  lastMessageAt: string;
  speakers: Array<{ id: string; displayName: string; lastSeenAt: string }>;
};

type LineWebhookDebugState = {
  lastRequestAt: string | null;
  lastSignaturePresent: boolean;
  lastSignatureValid: boolean | null;
  lastEventCount: number;
  lastEventTypes: string[];
  lastHttpStatus: number | null;
  lastNote: string | null;
  lastRelayAttemptAt: string | null;
  lastRelaySucceeded: boolean | null;
  lastRelayError: string | null;
};

const lineWebhookDebugState: LineWebhookDebugState = {
  lastRequestAt: null,
  lastSignaturePresent: false,
  lastSignatureValid: null,
  lastEventCount: 0,
  lastEventTypes: [],
  lastHttpStatus: null,
  lastNote: null,
  lastRelayAttemptAt: null,
  lastRelaySucceeded: null,
  lastRelayError: null,
};

const lineRecentGroups = new Map<string, LineGroupOption>();

const lineClient = config.line.enabled
  ? new Client({
      channelAccessToken: config.line.channelAccessToken as string,
    })
  : null;

function getSignature(req: Request): string {
  const signature = req.header('x-line-signature');
  return signature ?? '';
}

function getRawBody(req: RawBodyRequest): string {
  if (!req.rawBody) {
    return '';
  }
  return req.rawBody.toString('utf8');
}

async function getSenderName(event: WebhookEvent): Promise<string | undefined> {
  if (!lineClient) {
    return undefined;
  }

  if (!('source' in event)) {
    return undefined;
  }

  const source = event.source as LineSource;
  const userId = source.userId;
  if (!userId) {
    return undefined;
  }

  try {
    if (source.type === 'user') {
      const profile = await lineClient.getProfile(userId);
      return profile.displayName;
    }

    if (source.type === 'group') {
      const profile = await lineClient.getGroupMemberProfile(source.groupId, userId);
      return profile.displayName;
    }

    if (source.type === 'room') {
      const profile = await lineClient.getRoomMemberProfile(source.roomId, userId);
      return profile.displayName;
    }
  } catch (err) {
    logger.warn({ err, sourceType: source.type, userId }, 'Failed to fetch LINE sender profile');
  }

  return undefined;
}

async function getGroupName(source: LineSource): Promise<string | undefined> {
  if (!lineClient || source.type !== 'group') {
    return undefined;
  }

  try {
    const summary = await lineClient.getGroupSummary(source.groupId);
    if (summary.groupName?.trim()) {
      return summary.groupName.trim();
    }
  } catch (err) {
    logger.warn({ err, groupId: source.groupId }, 'Failed to fetch LINE group summary');
  }

  return undefined;
}

async function rememberLineGroup(event: WebhookEvent, senderName?: string): Promise<void> {
  if (event.type !== 'message' || event.source.type !== 'group') {
    return;
  }

  const groupId = event.source.groupId;
  const now = new Date().toISOString();
  const groupName = (await getGroupName(event.source)) ?? `LINE 群組 (${groupId})`;
  const speakerId = event.source.userId ?? 'unknown';
  const speakerName = senderName?.trim() || speakerId;

  const existing = lineRecentGroups.get(groupId) ?? {
    id: groupId,
    name: groupName,
    lastMessageAt: now,
    speakers: [],
  };

  existing.name = groupName;
  existing.lastMessageAt = now;

  const speakerIdx = existing.speakers.findIndex((speaker) => speaker.id === speakerId);
  if (speakerIdx === -1) {
    existing.speakers.push({ id: speakerId, displayName: speakerName, lastSeenAt: now });
  } else {
    existing.speakers[speakerIdx] = {
      id: speakerId,
      displayName: speakerName,
      lastSeenAt: now,
    };
  }

  existing.speakers.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  lineRecentGroups.set(groupId, existing);

  if (lineRecentGroups.size > 30) {
    const oldest = Array.from(lineRecentGroups.values())
      .sort((a, b) => a.lastMessageAt.localeCompare(b.lastMessageAt))
      .slice(0, lineRecentGroups.size - 30);
    for (const item of oldest) {
      lineRecentGroups.delete(item.id);
    }
  }
}

export async function handleLineWebhook(req: Request, res: Response): Promise<void> {
  lineWebhookDebugState.lastRequestAt = new Date().toISOString();

  if (!config.line.enabled) {
    lineWebhookDebugState.lastSignaturePresent = false;
    lineWebhookDebugState.lastSignatureValid = null;
    lineWebhookDebugState.lastEventCount = 0;
    lineWebhookDebugState.lastEventTypes = [];
    lineWebhookDebugState.lastHttpStatus = 503;
    lineWebhookDebugState.lastNote = 'LINE source disabled (env missing or placeholder).';
    lineWebhookDebugState.lastRelaySucceeded = null;
    lineWebhookDebugState.lastRelayError = null;
    logger.warn('LINE webhook request received but LINE source is disabled or using placeholder env values');
    res.status(503).json({
      ok: false,
      message: 'LINE integration is disabled (missing LINE env).',
    });
    return;
  }

  const rawBody = getRawBody(req as RawBodyRequest);
  const signature = getSignature(req);
  lineWebhookDebugState.lastSignaturePresent = Boolean(signature);

  if (!rawBody || !signature) {
    lineWebhookDebugState.lastSignatureValid = null;
    lineWebhookDebugState.lastEventCount = 0;
    lineWebhookDebugState.lastEventTypes = [];
    lineWebhookDebugState.lastHttpStatus = 400;
    lineWebhookDebugState.lastNote = 'Missing signature header or raw body.';
    lineWebhookDebugState.lastRelaySucceeded = null;
    lineWebhookDebugState.lastRelayError = null;
    logger.warn('LINE webhook missing signature or raw body');
    res.status(400).json({ ok: false, message: 'Invalid LINE webhook request.' });
    return;
  }

  const isValidSignature = validateSignature(
    rawBody,
    config.line.channelSecret as string,
    signature,
  );
  lineWebhookDebugState.lastSignatureValid = isValidSignature;

  if (!isValidSignature) {
    lineWebhookDebugState.lastEventCount = 0;
    lineWebhookDebugState.lastEventTypes = [];
    lineWebhookDebugState.lastHttpStatus = 403;
    lineWebhookDebugState.lastNote = 'Invalid LINE signature.';
    lineWebhookDebugState.lastRelaySucceeded = null;
    lineWebhookDebugState.lastRelayError = null;
    logger.warn('LINE signature validation failed');
    res.status(403).json({ ok: false, message: 'Invalid LINE signature.' });
    return;
  }

  const body = req.body as { events?: WebhookEvent[] };
  const events = body.events ?? [];
  lineWebhookDebugState.lastEventCount = events.length;
  lineWebhookDebugState.lastEventTypes = events.map((event) => event.type);

  if (events.length === 0) {
    lineWebhookDebugState.lastNote = 'Verified request with empty events payload.';
    logger.info('LINE webhook verified with empty events payload');
  } else {
    lineWebhookDebugState.lastNote = 'Received LINE events payload.';
    logger.info(
      {
        eventCount: events.length,
        eventTypes: events.map((event) => event.type),
      },
      'LINE webhook received events',
    );
  }

  for (const event of events) {
    const senderName = await getSenderName(event);
    await rememberLineGroup(event, senderName);
    const normalized = normalizeLineEvent(event, senderName);

    if (!normalized) {
      logger.info(
        {
          eventType: event.type,
          messageType:
            event.type === 'message' && 'message' in event
              ? (event.message as { type?: string }).type
              : undefined,
        },
        'Skip unsupported LINE event or non-text message',
      );
      continue;
    }

    try {
      lineWebhookDebugState.lastRelayAttemptAt = new Date().toISOString();
      await relayIncomingMessage({
        source: 'line',
        message: normalized,
        line: {
          groupId: event.source.type === 'group' ? event.source.groupId : undefined,
          speakerId: event.source.userId,
        },
      });
      lineWebhookDebugState.lastRelaySucceeded = true;
      lineWebhookDebugState.lastRelayError = null;
    } catch (err) {
      lineWebhookDebugState.lastRelaySucceeded = false;
      lineWebhookDebugState.lastRelayError = err instanceof Error ? err.message : String(err);
      logger.error({ err, eventType: event.type }, 'Failed to forward LINE message to Slack');
    }
  }

  lineWebhookDebugState.lastHttpStatus = 200;
  res.json({ ok: true });
}

async function startLineSource(): Promise<void> {
  if (!config.line.enabled) {
    logger.info('LINE source adapter is disabled (missing or placeholder LINE env)');
    return;
  }

  logger.info('LINE source adapter is enabled');
}

export const lineSourceAdapter: SourceAdapter = {
  key: 'line',
  start: startLineSource,
};

export function getLineWebhookDebugState(): LineWebhookDebugState {
  return { ...lineWebhookDebugState };
}

export function getLineRecentGroupOptions(): LineGroupOption[] {
  return Array.from(lineRecentGroups.values())
    .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
    .map((group) => ({
      ...group,
      speakers: [...group.speakers],
    }));
}
