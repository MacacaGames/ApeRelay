import { Client, validateSignature, type WebhookEvent } from '@line/bot-sdk';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { relayIncomingMessage } from '../core/relayPipeline.js';
import { logger } from '../logger.js';
import { normalizeLineEvent } from '../normalizer/lineNormalizer.js';
import type { SourceAdapter } from './types.js';

type RawBodyRequest = Request & { rawBody?: Buffer };
type LineSource = WebhookEvent['source'];

type LineWebhookDebugState = {
  lastRequestAt: string | null;
  lastSignaturePresent: boolean;
  lastSignatureValid: boolean | null;
  lastEventCount: number;
  lastEventTypes: string[];
  lastHttpStatus: number | null;
  lastNote: string | null;
};

const lineWebhookDebugState: LineWebhookDebugState = {
  lastRequestAt: null,
  lastSignaturePresent: false,
  lastSignatureValid: null,
  lastEventCount: 0,
  lastEventTypes: [],
  lastHttpStatus: null,
  lastNote: null,
};

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

export async function handleLineWebhook(req: Request, res: Response): Promise<void> {
  lineWebhookDebugState.lastRequestAt = new Date().toISOString();

  if (!config.line.enabled) {
    lineWebhookDebugState.lastSignaturePresent = false;
    lineWebhookDebugState.lastSignatureValid = null;
    lineWebhookDebugState.lastEventCount = 0;
    lineWebhookDebugState.lastEventTypes = [];
    lineWebhookDebugState.lastHttpStatus = 503;
    lineWebhookDebugState.lastNote = 'LINE source disabled (env missing or placeholder).';
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
      await relayIncomingMessage({
        source: 'line',
        message: normalized,
      });
    } catch (err) {
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
